import { describe, expect, test } from 'vitest'
import { createGmailMcpServer, type JsonRpcResponse } from './server'
import { decodeBase64Url } from './gmailCore'

interface FetchCall {
  url: string
  init?: RequestInit
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function text(body: string, status = 200) {
  return new Response(body, { status })
}

function testServer(fetchFn: typeof fetch) {
  const messages: JsonRpcResponse[] = []
  const server = createGmailMcpServer({
    env: {
      ZSPARK_GMAIL_CLIENT_ID: 'client-id',
      ZSPARK_GMAIL_CLIENT_SECRET: 'client-secret',
      ZSPARK_GMAIL_REFRESH_TOKEN: 'refresh-token',
      ZSPARK_GMAIL_USER_EMAIL: 'me@example.com'
    },
    fetchFn,
    writeMessage: (message) => messages.push(message)
  })
  return { messages, server }
}

describe('Gmail MCP JSON-RPC server', () => {
  test('handles initialize, tools/list, ping, and unknown methods', async () => {
    const { messages, server } = testServer(async () => json({}))

    await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'ping' })
    await server.handleRequest({ jsonrpc: '2.0', id: 4, method: 'missing' })
    await server.handleRequest({ jsonrpc: '2.0', id: 5, method: 'notifications/initialized' })

    expect(messages).toHaveLength(4)
    expect(messages[0].result).toMatchObject({ protocolVersion: '2024-11-05' })
    expect((messages[1].result as any).tools.map((tool: any) => tool.name)).toContain('mail.send')
    expect(messages[2].result).toEqual({})
    expect(messages[3].error).toEqual({ code: -32601, message: 'Method not found: missing' })
  })

  test('refreshes OAuth token once and sends mail through Gmail API', async () => {
    const calls: FetchCall[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') {
        return json({ access_token: 'access-token', expires_in: 3600 })
      }
      if (url.endsWith('/messages/send')) {
        return json({ id: 'sent-1' })
      }
      return text('unexpected', 500)
    }) as typeof fetch
    const { messages, server } = testServer(fetchFn)

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 'send',
      method: 'tools/call',
      params: {
        name: 'mail.send',
        arguments: { to: ['you@example.com'], subject: 'Hi', body: 'Hello' }
      }
    })

    expect(messages).toHaveLength(1)
    expect(messages[0].error).toBeUndefined()
    expect(JSON.parse((messages[0].result as any).content[0].text)).toEqual({ id: 'sent-1' })
    expect(calls.map((call) => call.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
    ])
    const sendBody = JSON.parse(String(calls[1].init?.body))
    const rfc822 = decodeBase64Url(sendBody.raw)
    expect(rfc822).toContain('From: me@example.com')
    expect(rfc822).toContain('To: you@example.com')
    expect((calls[1].init?.headers as Headers).get('Authorization')).toBe('Bearer access-token')
  })

  test('reports OAuth and tool validation failures as JSON-RPC errors', async () => {
    const { messages, server } = testServer(async () => text('bad refresh', 400))

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 'bad-oauth',
      method: 'tools/call',
      params: { name: 'mail.list', arguments: {} }
    })
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 'bad-tool',
      method: 'tools/call',
      params: { arguments: {} }
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].error?.message).toContain('OAuth refresh failed: 400 bad refresh')
    expect(messages[1].error).toEqual({ code: -32000, message: 'tools/call requires name' })
  })
})
