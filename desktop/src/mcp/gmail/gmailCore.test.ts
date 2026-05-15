import { describe, expect, test } from 'vitest'
import {
  buildCalendarEventPayload,
  buildRfc822Message,
  decodeBase64Url,
  encodeBase64Url,
  encodeGmailSendBody,
  GMAIL_MCP_TOOLS,
  GMAIL_MESSAGE_BODY_LIMIT,
  parseGmailMessage,
  tokenIsFresh
} from './gmailCore'

describe('tokenIsFresh', () => {
  test('rejects missing or expired tokens', () => {
    expect(tokenIsFresh(null)).toBe(false)
    expect(tokenIsFresh({ accessToken: '', expiresAt: 0 })).toBe(false)
    expect(tokenIsFresh({ accessToken: 'a', expiresAt: 1000 }, 999_999)).toBe(false)
  })
  test('honors 60s skew window', () => {
    const now = 1_700_000_000_000
    expect(tokenIsFresh({ accessToken: 'a', expiresAt: now + 30_000 }, now)).toBe(false)
    expect(tokenIsFresh({ accessToken: 'a', expiresAt: now + 120_000 }, now)).toBe(true)
  })
})

describe('base64url helpers', () => {
  test('round-trips arbitrary text', () => {
    const original = 'héllo + world?\n'
    expect(decodeBase64Url(encodeBase64Url(original))).toBe(original)
  })
})

describe('buildRfc822Message', () => {
  test('emits To/Subject/MIME headers and CRLF body delimiter', () => {
    const msg = buildRfc822Message({
      to: ['a@x.com', 'b@x.com'],
      subject: 'Hi',
      body: 'Hello there.'
    })
    expect(msg).toContain('To: a@x.com, b@x.com')
    expect(msg).toContain('Subject: Hi')
    expect(msg).toContain('MIME-Version: 1.0')
    expect(msg).toContain('Content-Transfer-Encoding: base64')
    expect(Buffer.from(msg.split('\r\n\r\n')[1], 'base64').toString('utf8')).toBe('Hello there.')
  })

  test('adds optional From and Cc only when supplied', () => {
    const without = buildRfc822Message({ to: ['a@x.com'], subject: 's', body: 'b' })
    expect(without).not.toContain('Cc:')
    expect(without).not.toContain('From:')
    const withExtras = buildRfc822Message({
      to: ['a@x.com'],
      cc: ['c@x.com'],
      from: 'me@x.com',
      subject: 's',
      body: 'b'
    })
    expect(withExtras).toContain('From: me@x.com')
    expect(withExtras).toContain('Cc: c@x.com')
  })

  test('sanitizes injected header newlines and encodes non-ascii subjects', () => {
    const msg = buildRfc822Message({
      from: 'me@x.com\r\nBcc: attacker@x.com',
      to: ['a@x.com\r\nBcc: attacker@x.com'],
      cc: ['c@x.com'],
      subject: '季度总结',
      body: '中文 body'
    })
    const headers = msg.split('\r\n\r\n')[0]
    expect(headers).not.toContain('\r\nBcc:')
    expect(headers).toContain('From: me@x.com Bcc: attacker@x.com')
    expect(headers).toContain('To: a@x.com Bcc: attacker@x.com')
    expect(headers).toContain(`Subject: =?UTF-8?B?${Buffer.from('季度总结').toString('base64')}?=`)
    expect(Buffer.from(msg.split('\r\n\r\n')[1], 'base64').toString('utf8')).toBe('中文 body')
  })
})

describe('encodeGmailSendBody', () => {
  test('produces base64url with no padding', () => {
    const encoded = encodeGmailSendBody('hi?')
    expect(encoded).not.toContain('=')
    expect(decodeBase64Url(encoded)).toBe('hi?')
  })
})

describe('parseGmailMessage', () => {
  test('returns null for malformed input', () => {
    expect(parseGmailMessage(null)).toBeNull()
    expect(parseGmailMessage({})).toBeNull()
  })

  test('extracts headers, snippet, and text/plain body', () => {
    const raw = {
      id: 'abc',
      threadId: 't1',
      snippet: 'preview',
      payload: {
        headers: [
          { name: 'From', value: 'a@x.com' },
          { name: 'To', value: 'b@x.com' },
          { name: 'Subject', value: 'hi' },
          { name: 'Date', value: 'Fri, 1 Jan 2026 00:00:00 +0000' }
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: encodeBase64Url('hello body') } },
          { mimeType: 'text/html', body: { data: encodeBase64Url('<p>hello</p>') } }
        ]
      }
    }
    const parsed = parseGmailMessage(raw)
    expect(parsed?.id).toBe('abc')
    expect(parsed?.from).toBe('a@x.com')
    expect(parsed?.subject).toBe('hi')
    expect(parsed?.body).toBe('hello body')
    expect(parsed?.snippet).toBe('preview')
  })

  test('truncates very large message bodies before exposing them to the model', () => {
    const body = 'x'.repeat(GMAIL_MESSAGE_BODY_LIMIT + 10)
    const raw = {
      id: 'large',
      payload: {
        headers: [],
        body: { data: encodeBase64Url(body) }
      }
    }
    const parsed = parseGmailMessage(raw)
    expect(parsed?.body?.length).toBeLessThan(body.length)
    expect(parsed?.body).toContain('[truncated')
  })

  test('falls back to a non-text part when no text/plain exists', () => {
    const raw = {
      id: 'x',
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        body: { data: encodeBase64Url('top-level body') }
      }
    }
    expect(parseGmailMessage(raw)?.body).toBe('top-level body')
  })
})

describe('buildCalendarEventPayload', () => {
  test('rejects missing title / timestamps', () => {
    expect(() => buildCalendarEventPayload({ title: '', start: 's', end: 'e' })).toThrow()
    expect(() => buildCalendarEventPayload({ title: 't', start: '', end: 'e' })).toThrow()
  })

  test('emits attendees and Meet conference data on request', () => {
    const payload = buildCalendarEventPayload({
      title: 'sync',
      start: '2026-05-15T10:00:00Z',
      end: '2026-05-15T11:00:00Z',
      attendees: ['a@x.com', 'b@x.com'],
      conference: 'meet',
      timeZone: 'Asia/Shanghai'
    })
    expect(payload.summary).toBe('sync')
    expect(payload.start).toEqual({ dateTime: '2026-05-15T10:00:00Z', timeZone: 'Asia/Shanghai' })
    expect(payload.end).toEqual({ dateTime: '2026-05-15T11:00:00Z', timeZone: 'Asia/Shanghai' })
    expect(payload.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }])
    expect(payload.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe('hangoutsMeet')
  })

  test('omits conferenceData when conference is none/undefined', () => {
    const payload = buildCalendarEventPayload({
      title: 't',
      start: '2026-05-15T10:00:00Z',
      end: '2026-05-15T11:00:00Z'
    })
    expect(payload.conferenceData).toBeUndefined()
  })
})

describe('GMAIL_MCP_TOOLS', () => {
  test('exposes provider-agnostic tool names', () => {
    const names = GMAIL_MCP_TOOLS.map((t) => t.name)
    expect(names).toEqual(['mail.list', 'mail.get', 'mail.search', 'mail.send', 'calendar.create_event'])
  })
})
