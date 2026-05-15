#!/usr/bin/env node
/**
 * zspark Gmail MCP server — stdio JSON-RPC.
 *
 * Speaks the Model Context Protocol over stdin/stdout. Credentials are
 * provided via environment variables (set by the zspark main process from
 * Electron safeStorage so they never hit disk in plaintext):
 *
 *   ZSPARK_GMAIL_CLIENT_ID
 *   ZSPARK_GMAIL_CLIENT_SECRET
 *   ZSPARK_GMAIL_REFRESH_TOKEN
 *   ZSPARK_GMAIL_USER_EMAIL  (optional — used as the From: header)
 *
 * This file is intentionally dependency-free (no MCP SDK import) so it can
 * be bundled into the Electron app without bringing in heavy transitive
 * deps. The protocol surface implemented matches the subset of MCP that
 * codex-rs consumes: `initialize`, `tools/list`, `tools/call`, and
 * `notifications/initialized`.
 */

import { createInterface } from 'node:readline'
import {
  buildCalendarEventPayload,
  buildRfc822Message,
  encodeGmailSendBody,
  GMAIL_MCP_TOOLS,
  parseGmailMessage,
  tokenIsFresh,
  type OAuthToken
} from './gmailCore'

const PROTOCOL_VERSION = '2024-11-05'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

let cachedToken: OAuthToken | null = null

function writeMessage(msg: JsonRpcResponse) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function ok(id: number | string | null, result: unknown) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function fail(id: number | string | null, code: number, message: string) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

async function refreshAccessToken(): Promise<OAuthToken> {
  const clientId = process.env.ZSPARK_GMAIL_CLIENT_ID
  const clientSecret = process.env.ZSPARK_GMAIL_CLIENT_SECRET
  const refreshToken = process.env.ZSPARK_GMAIL_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail MCP server is missing OAuth env vars (ZSPARK_GMAIL_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN).')
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
  if (!res.ok) {
    throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`)
  }
  const data: any = await res.json()
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000
  }
}

async function getAccessToken(): Promise<string> {
  if (tokenIsFresh(cachedToken)) return cachedToken!.accessToken
  cachedToken = await refreshAccessToken()
  return cachedToken.accessToken
}

async function googleFetch(url: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken()
  const headers = new Headers(init.headers ?? {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google API ${res.status}: ${text}`)
  }
  return res.json()
}

async function callMailList(params: { query?: string; max?: number }) {
  const max = Math.max(1, Math.min(Number(params?.max ?? 10), 50))
  const search = new URLSearchParams({ maxResults: String(max) })
  if (params?.query) search.set('q', params.query)
  const list: any = await googleFetch(`${GMAIL_BASE}/messages?${search.toString()}`)
  const ids: string[] = Array.isArray(list?.messages) ? list.messages.map((m: any) => m.id).filter(Boolean) : []
  const messages = await Promise.all(ids.map(async (id) => {
    const detail = await googleFetch(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`)
    return parseGmailMessage(detail)
  }))
  return { messages: messages.filter(Boolean) }
}

async function callMailGet(params: { id: string }) {
  if (!params?.id) throw new Error('mail.get requires id')
  const detail = await googleFetch(`${GMAIL_BASE}/messages/${encodeURIComponent(params.id)}?format=full`)
  const parsed = parseGmailMessage(detail)
  if (!parsed) throw new Error('Message not found or unparseable')
  return parsed
}

async function callMailSend(params: { to: string[]; cc?: string[]; subject: string; body: string }) {
  if (!Array.isArray(params?.to) || params.to.length === 0) throw new Error('mail.send requires non-empty to[]')
  const rfc822 = buildRfc822Message({
    to: params.to,
    cc: params.cc,
    subject: params.subject ?? '',
    body: params.body ?? '',
    from: process.env.ZSPARK_GMAIL_USER_EMAIL || undefined
  })
  const raw = encodeGmailSendBody(rfc822)
  return googleFetch(`${GMAIL_BASE}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ raw })
  })
}

async function callCalendarCreate(params: any) {
  const payload = buildCalendarEventPayload(params)
  const url = `${CALENDAR_BASE}/events${params.conference === 'meet' ? '?conferenceDataVersion=1' : ''}`
  return googleFetch(url, { method: 'POST', body: JSON.stringify(payload) })
}

async function dispatchTool(name: string, args: any) {
  switch (name) {
    case 'mail.list': return callMailList(args ?? {})
    case 'mail.search': return callMailList({ ...(args ?? {}), query: args?.query })
    case 'mail.get': return callMailGet(args ?? {})
    case 'mail.send': return callMailSend(args ?? {})
    case 'calendar.create_event': return callCalendarCreate(args ?? {})
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleRequest(req: JsonRpcRequest) {
  const id = req.id ?? null
  try {
    switch (req.method) {
      case 'initialize': {
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'zspark-gmail', version: '0.1.0' }
        })
      }
      case 'notifications/initialized': return // notification, no reply
      case 'tools/list': {
        return ok(id, { tools: GMAIL_MCP_TOOLS })
      }
      case 'tools/call': {
        const name = req.params?.name
        if (typeof name !== 'string') throw new Error('tools/call requires name')
        const result = await dispatchTool(name, req.params?.arguments)
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        })
      }
      case 'ping': return ok(id, {})
      default:
        return fail(id, -32601, `Method not found: ${req.method}`)
    }
  } catch (err: any) {
    fail(id, -32000, err?.message ?? String(err))
  }
}

function start() {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed)
    } catch {
      fail(null, -32700, 'Parse error')
      return
    }
    handleRequest(req).catch((err) => fail(req.id ?? null, -32000, err?.message ?? String(err)))
  })
  rl.on('close', () => process.exit(0))
}

start()
