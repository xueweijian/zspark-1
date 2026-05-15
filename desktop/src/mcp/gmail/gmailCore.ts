/**
 * Pure helpers for the Gmail / Google Calendar MCP server. Side-effects
 * (network, fs) live in server.ts; everything here is testable with vitest.
 */

export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number // epoch ms
}

export interface GmailMessage {
  id: string
  threadId?: string
  from?: string
  to?: string
  subject?: string
  date?: string
  snippet?: string
  body?: string
}

export interface CalendarEventInput {
  title: string
  start: string // ISO 8601
  end: string
  timeZone?: string
  attendees?: string[]
  body?: string
  conference?: 'meet' | 'none'
}

const REFRESH_SKEW_MS = 60_000
export const GMAIL_MESSAGE_BODY_LIMIT = 16_000

export function tokenIsFresh(token: OAuthToken | null | undefined, nowMs = Date.now()): boolean {
  if (!token || !token.accessToken) return false
  return token.expiresAt - REFRESH_SKEW_MS > nowMs
}

export function decodeBase64Url(input: string): string {
  if (!input) return ''
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + ((4 - (input.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sanitizeHeaderValue(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

function encodeMimeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value)
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

function formatAddressList(values: string[]): string {
  return values.map(sanitizeHeaderValue).filter(Boolean).join(', ')
}

function wrapBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
}

/**
 * Build an RFC 5322 message and encode it the way Gmail's `users.messages.send`
 * expects (base64url of the full MIME envelope).
 */
export function buildRfc822Message(args: {
  to: string[]
  cc?: string[]
  subject: string
  body: string
  from?: string
}): string {
  const body = wrapBase64(args.body)
  const headers = [
    args.from ? `From: ${sanitizeHeaderValue(args.from)}` : null,
    `To: ${formatAddressList(args.to)}`,
    args.cc && args.cc.length > 0 ? `Cc: ${formatAddressList(args.cc)}` : null,
    `Subject: ${encodeMimeHeaderValue(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ].filter((line): line is string => Boolean(line))
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

export function encodeGmailSendBody(rfc822: string): string {
  return encodeBase64Url(rfc822)
}

interface ParsedHeader {
  name: string
  value: string
}

function pickHeader(headers: ParsedHeader[], name: string): string | undefined {
  const target = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === target)?.value
}

function flattenParts(payload: any): any[] {
  if (!payload) return []
  if (!Array.isArray(payload.parts) || payload.parts.length === 0) return [payload]
  return payload.parts.flatMap((p: any) => flattenParts(p))
}

function decodeBodyData(data: string | undefined): string {
  if (!data) return ''
  try {
    return decodeBase64Url(data)
  } catch {
    return ''
  }
}

function truncateGmailBody(body: string): string {
  if (body.length <= GMAIL_MESSAGE_BODY_LIMIT) return body
  const suffix = `\n\n[truncated; original length ${body.length} characters]`
  const visibleLimit = Math.max(0, GMAIL_MESSAGE_BODY_LIMIT - suffix.length)
  return `${body.slice(0, visibleLimit)}${suffix}`
}

/**
 * Convert a Gmail API `users.messages.get` (format=full) payload into the
 * compact shape we expose through MCP.
 */
export function parseGmailMessage(raw: any): GmailMessage | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  const headers: ParsedHeader[] = Array.isArray(raw?.payload?.headers) ? raw.payload.headers : []
  const parts = flattenParts(raw.payload)
  const textPart = parts.find((p) => p?.mimeType === 'text/plain' && p?.body?.data)
  const fallbackPart = parts.find((p) => p?.body?.data)
  const body = truncateGmailBody(decodeBodyData(textPart?.body?.data ?? fallbackPart?.body?.data))
  return {
    id: raw.id,
    threadId: typeof raw.threadId === 'string' ? raw.threadId : undefined,
    from: pickHeader(headers, 'From'),
    to: pickHeader(headers, 'To'),
    subject: pickHeader(headers, 'Subject'),
    date: pickHeader(headers, 'Date'),
    snippet: typeof raw.snippet === 'string' ? raw.snippet : undefined,
    body: body || undefined
  }
}

export function buildCalendarEventPayload(input: CalendarEventInput) {
  if (!input.title?.trim()) throw new Error('Calendar event requires a title')
  if (!input.start || !input.end) throw new Error('Calendar event requires start and end timestamps')

  const payload: any = {
    summary: input.title.trim(),
    description: input.body,
    start: { dateTime: input.start },
    end: { dateTime: input.end }
  }
  if (input.timeZone?.trim()) {
    payload.start.timeZone = input.timeZone.trim()
    payload.end.timeZone = input.timeZone.trim()
  }
  if (input.attendees && input.attendees.length > 0) {
    payload.attendees = input.attendees.map((email) => ({ email }))
  }
  if (input.conference === 'meet') {
    payload.conferenceData = {
      createRequest: {
        requestId: `zspark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  }
  return payload
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Provider-agnostic tool names so a future Microsoft Graph adapter can
 * implement the same surface and the assistant doesn't need to know which
 * provider is wired up.
 */
export const GMAIL_MCP_TOOLS: ToolDescriptor[] = [
  {
    name: 'mail.list',
    description: 'List recent email messages from the connected mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "is:unread newer_than:7d"' },
        max: { type: 'number', description: 'Max number of messages to return (default 10).' }
      }
    }
  },
  {
    name: 'mail.get',
    description: 'Fetch the full body and headers of a single message by id.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  },
  {
    name: 'mail.search',
    description: 'Search the mailbox; same as mail.list but query is required.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max: { type: 'number' }
      }
    }
  },
  {
    name: 'mail.send',
    description: 'Send a plain-text email from the connected mailbox.',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
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
      type: 'object',
      required: ['title', 'start', 'end'],
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 start timestamp.' },
        end: { type: 'string', description: 'ISO 8601 end timestamp.' },
        timeZone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Shanghai".' },
        attendees: { type: 'array', items: { type: 'string' } },
        body: { type: 'string' },
        conference: { type: 'string', enum: ['meet', 'none'] }
      }
    }
  }
]
