#!/usr/bin/env node
/**
 * Self-contained zspark Gmail MCP server. Plain ESM JavaScript — no
 * compilation step, can be launched directly with `node`.
 *
 * Env vars required at launch (set per-server in zspark Settings → MCP):
 *   ZSPARK_GMAIL_CLIENT_ID
 *   ZSPARK_GMAIL_CLIENT_SECRET
 *   ZSPARK_GMAIL_REFRESH_TOKEN
 *   ZSPARK_GMAIL_USER_EMAIL  (optional From: header)
 */

import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary'
const REFRESH_SKEW_MS = 60_000

let cachedToken = null

function tokenIsFresh(token, nowMs = Date.now()) {
  return Boolean(token?.accessToken) && token.expiresAt - REFRESH_SKEW_MS > nowMs
}

function decodeBase64Url(input) {
  if (!input) return ''
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + ((4 - (input.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function encodeBase64Url(input) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildRfc822({ to, cc, subject, body, from }) {
  const headers = [
    from ? `From: ${from}` : null,
    `To: ${to.join(', ')}`,
    cc?.length ? `Cc: ${cc.join(', ')}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit'
  ].filter(Boolean)
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

function pickHeader(headers, name) {
  const target = name.toLowerCase()
  return headers.find((h) => h.name?.toLowerCase() === target)?.value
}

function flattenParts(payload) {
  if (!payload) return []
  if (!Array.isArray(payload.parts) || payload.parts.length === 0) return [payload]
  return payload.parts.flatMap(flattenParts)
}

function parseGmailMessage(raw) {
  if (!raw || typeof raw.id !== 'string') return null
  const headers = Array.isArray(raw?.payload?.headers) ? raw.payload.headers : []
  const parts = flattenParts(raw.payload)
  const text = parts.find((p) => p?.mimeType === 'text/plain' && p?.body?.data)
  const fallback = parts.find((p) => p?.body?.data)
  const data = text?.body?.data ?? fallback?.body?.data
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: pickHeader(headers, 'From'),
    to: pickHeader(headers, 'To'),
    subject: pickHeader(headers, 'Subject'),
    date: pickHeader(headers, 'Date'),
    snippet: raw.snippet,
    body: data ? decodeBase64Url(data) : undefined
  }
}

const TOOLS = [
  {
    name: 'mail.list',
    description: 'List recent email messages from the connected mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "is:unread newer_than:7d"' },
        max: { type: 'number', description: 'Max results (default 10, cap 50).' }
      }
    }
  },
  {
    name: 'mail.get',
    description: 'Fetch full body and headers of a single message by id.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
  },
  {
    name: 'mail.search',
    description: 'Search the mailbox; same as mail.list but query is required.',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, max: { type: 'number' } }
    }
  },
  {
    name: 'mail.send',
    description: 'Send a plain-text email from the connected mailbox.',
    inputSchema: {
      type: 'object', required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' }
      }
    }
  },
  {
    name: 'calendar.create_event',
    description: 'Create a calendar event, optionally with a Google Meet link.',
    inputSchema: {
      type: 'object', required: ['title', 'start', 'end'],
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 start.' },
        end: { type: 'string', description: 'ISO 8601 end.' },
        attendees: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        conference: { type: 'string', enum: ['meet', 'none'] }
      }
    }
  }
]

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

async function refreshAccessToken() {
  const clientId = process.env.ZSPARK_GMAIL_CLIENT_ID
  const clientSecret = process.env.ZSPARK_GMAIL_CLIENT_SECRET
  const refreshToken = process.env.ZSPARK_GMAIL_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing ZSPARK_GMAIL_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN env vars.')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000
  }
}

async function getAccessToken() {
  if (tokenIsFresh(cachedToken)) return cachedToken.accessToken
  cachedToken = await refreshAccessToken()
  return cachedToken.accessToken
}

async function googleFetch(url, init = {}) {
  const token = await getAccessToken()
  const headers = new Headers(init.headers ?? {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function callMailList({ query, max } = {}) {
  const cap = Math.max(1, Math.min(Number(max ?? 10), 50))
  const search = new URLSearchParams({ maxResults: String(cap) })
  if (query) search.set('q', query)
  const list = await googleFetch(`${GMAIL_BASE}/messages?${search}`)
  const ids = Array.isArray(list?.messages) ? list.messages.map((m) => m.id).filter(Boolean) : []
  const messages = await Promise.all(ids.map(async (id) => {
    const detail = await googleFetch(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`)
    return parseGmailMessage(detail)
  }))
  return { messages: messages.filter(Boolean) }
}

async function callMailGet({ id }) {
  if (!id) throw new Error('mail.get requires id')
  const detail = await googleFetch(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`)
  const parsed = parseGmailMessage(detail)
  if (!parsed) throw new Error('Message not found or unparseable')
  return parsed
}

async function callMailSend({ to, cc, subject, body }) {
  if (!Array.isArray(to) || to.length === 0) throw new Error('mail.send requires non-empty to[]')
  const rfc822 = buildRfc822({ to, cc, subject: subject ?? '', body: body ?? '', from: process.env.ZSPARK_GMAIL_USER_EMAIL })
  const raw = encodeBase64Url(rfc822)
  return googleFetch(`${GMAIL_BASE}/messages/send`, { method: 'POST', body: JSON.stringify({ raw }) })
}

async function callCalendarCreate(params = {}) {
  if (!params.title?.trim()) throw new Error('Calendar event requires title')
  if (!params.start || !params.end) throw new Error('Calendar event requires start and end')
  const payload = {
    summary: params.title.trim(),
    description: params.body,
    start: { dateTime: params.start },
    end: { dateTime: params.end }
  }
  if (Array.isArray(params.attendees) && params.attendees.length > 0) {
    payload.attendees = params.attendees.map((email) => ({ email }))
  }
  if (params.conference === 'meet') {
    payload.conferenceData = {
      createRequest: {
        requestId: `zspark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  }
  const url = `${CALENDAR_BASE}/events${params.conference === 'meet' ? '?conferenceDataVersion=1' : ''}`
  return googleFetch(url, { method: 'POST', body: JSON.stringify(payload) })
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'mail.list': return callMailList(args ?? {})
    case 'mail.search': return callMailList({ ...(args ?? {}), query: args?.query })
    case 'mail.get': return callMailGet(args ?? {})
    case 'mail.send': return callMailSend(args ?? {})
    case 'calendar.create_event': return callCalendarCreate(args ?? {})
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleRequest(req) {
  const id = req.id ?? null
  try {
    switch (req.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'zspark-gmail', version: '0.1.0' }
        })
      case 'notifications/initialized': return
      case 'tools/list': return ok(id, { tools: TOOLS })
      case 'tools/call': {
        const name = req.params?.name
        if (typeof name !== 'string') throw new Error('tools/call requires name')
        const result = await dispatchTool(name, req.params?.arguments)
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      }
      case 'ping': return ok(id, {})
      default: return fail(id, -32601, `Method not found: ${req.method}`)
    }
  } catch (err) {
    fail(id, -32000, err?.message ?? String(err))
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try { req = JSON.parse(trimmed) } catch { fail(null, -32700, 'Parse error'); return }
  handleRequest(req).catch((err) => fail(req.id ?? null, -32000, err?.message ?? String(err)))
})
rl.on('close', () => process.exit(0))
