import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { setUpstream, startBridge } from './bridge'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface CapturedRequest {
  path: string
  authorization?: string
  body: any
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  setUpstream(null)
  const pending = cleanup.splice(0).map((close) => close())
  await Promise.all(pending)
})

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>
): Promise<{ baseUrl: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = []
  const server = createServer(async (req, res) => {
    const rawBody = await readBody(req)
    const text = rawBody.toString('utf8')
    const body = text ? JSON.parse(text) : null
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body })
    await handler(req, res, body)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

async function startBridgeForTest() {
  const bridge = await startBridge()
  cleanup.push(bridge.close)
  return `http://127.0.0.1:${bridge.port}`
}

function postJson(url: string, payload: JsonValue, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    req.write(JSON.stringify(payload))
    req.end()
  })
}

function getText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'GET',
      headers
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function jsonResponse(res: ServerResponse, status: number, body: JsonValue) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function responseText(body: string): string {
  const json = JSON.parse(body)
  return json.output?.[0]?.content?.[0]?.text ?? ''
}

function parseSseEvents(body: string): any[] {
  return body
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith('data:')))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line))
}

describe('chat responses bridge', () => {
  test('accepts a full chat completions URL without appending chat/completions twice', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        jsonResponse(res, 404, { error: { message: `wrong path: ${req.url}` } })
        return
      }
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'ok' } }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1/chat/completions`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi'
    })

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.path).toBe('/v1/chat/completions')
    expect(responseText(response.body)).toBe('ok')
  })

  test('converts JSON chat responses into streamed Responses events when the upstream ignores stream=true', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'hello from json' } }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const events = parseSseEvents(response.body)
    expect(response.status).toBe(200)
    expect(events.some((event) => event.type === 'response.output_text.delta' && event.delta === 'hello from json')).toBe(true)
    expect(events.find((event) => event.type === 'response.completed')?.response.output[0].content[0].text).toBe('hello from json')
  })

  test('includes JSON chat reasoning in streamed completed output before tool calls', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'checking command',
            tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }]
          }
        }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const events = parseSseEvents(response.body)
    const completed = events.find((event) => event.type === 'response.completed')
    const output = completed?.response.output ?? []

    expect(response.status).toBe(200)
    expect(output.map((item: any) => item.type)).toEqual(['message', 'reasoning', 'function_call'])
    expect(output[1]?.id).toMatch(/^rs_/)
    expect(output[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"pwd"}'
    })
  })

  test('includes non-stream JSON chat reasoning in completed output before tool calls', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'checking command',
            tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{}' } }]
          }
        }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi'
    })

    const json = JSON.parse(response.body)

    expect(response.status).toBe(200)
    expect(json.output.map((item: any) => item.type)).toEqual(['message', 'reasoning', 'function_call'])
    expect(json.output[1]?.id).toMatch(/^rs_/)
    expect(json.output[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{}'
    })
  })

  test('includes streamed chat reasoning in completed output before tool calls', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking command' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{}' } }] } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const events = parseSseEvents(response.body)
    const completed = events.find((event) => event.type === 'response.completed')
    const output = completed?.response.output ?? []

    expect(response.status).toBe(200)
    expect(events.some((event) => event.type === 'response.output_item.done' && event.item?.type === 'reasoning')).toBe(true)
    expect(output.map((item: any) => item.type)).toEqual(['message', 'reasoning', 'function_call'])
    expect(output[1]?.id).toMatch(/^rs_/)
    expect(output[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{}'
    })
  })

  test('surfaces upstream chat errors as Responses failed events', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 400, { error: { message: 'tools are not supported by this model' } })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const events = parseSseEvents(response.body)
    expect(response.status).toBe(200)
    expect(events.find((event) => event.type === 'response.failed')?.response.error.message).toContain('tools are not supported')
  })

  test('converts chat token usage to Responses token usage', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'usage ok' } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const completed = parseSseEvents(response.body).find((event) => event.type === 'response.completed')
    expect(completed?.response.usage).toEqual({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 19
    })
  })

  test('keeps streaming usage frames from chat providers', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    const response = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: true,
      input: 'hi'
    })

    const completed = parseSseEvents(response.body).find((event) => event.type === 'response.completed')
    expect(completed?.response.usage).toEqual({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7
    })
  })

  test('keeps in-flight requests on the upstream captured at request start', async () => {
    let upstreamAReceived!: () => void
    const upstreamARequest = new Promise<void>((resolve) => { upstreamAReceived = resolve })
    const upstreamA = await startUpstream(async (_req, res) => {
      upstreamAReceived()
      await new Promise((resolve) => setTimeout(resolve, 20))
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'from a' } }]
      })
    })
    const upstreamB = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'from b' } }]
      })
    })
    cleanup.push(upstreamA.close, upstreamB.close)
    setUpstream({ baseUrl: `${upstreamA.baseUrl}/v1`, apiKey: 'key-a' })

    const bridgeUrl = await startBridgeForTest()
    const responsePromise = postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi'
    })
    await upstreamARequest
    setUpstream({ baseUrl: `${upstreamB.baseUrl}/v1`, apiKey: 'key-b' })
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(responseText(response.body)).toBe('from a')
    expect(upstreamA.requests).toHaveLength(1)
    expect(upstreamA.requests[0]?.authorization).toBe('Bearer key-a')
    expect(upstreamB.requests).toHaveLength(0)
  })

  test('sends only chat-compatible function tools upstream', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'tool mapping ok' } }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridgeUrl = await startBridgeForTest()
    await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi',
      tools: [
        { type: 'function', name: 'shell', description: 'Run shell', parameters: { type: 'object' } },
        { type: 'web_search', external_web_access: true }
      ]
    })

    expect(upstream.requests[0]?.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'Run shell',
          parameters: { type: 'object' }
        }
      }
    ])
  })

  test('requires the bridge token when configured', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'authorized' } }]
      })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'test-key' })

    const bridge = await startBridge('bridge-secret')
    cleanup.push(bridge.close)
    const bridgeUrl = `http://127.0.0.1:${bridge.port}`

    const rejected = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi'
    })
    expect(rejected.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)

    const accepted = await postJson(`${bridgeUrl}/v1/responses`, {
      model: 'test-model',
      stream: false,
      input: 'hi'
    }, { authorization: 'Bearer bridge-secret' })
    expect(accepted.status).toBe(200)
    expect(responseText(accepted.body)).toBe('authorized')
  })

  test('normalizes full chat completion URLs for model forwarding', async () => {
    const upstream = await startUpstream((_req, res) => {
      jsonResponse(res, 200, { data: [{ id: 'model-a' }] })
    })
    cleanup.push(upstream.close)
    setUpstream({ baseUrl: `${upstream.baseUrl}/v1/chat/completions`, apiKey: 'test-key' })

    const bridge = await startBridge('bridge-secret')
    cleanup.push(bridge.close)
    const response = await getText(`http://127.0.0.1:${bridge.port}/v1/models`, {
      authorization: 'Bearer bridge-secret'
    })

    expect(response.status).toBe(200)
    expect(upstream.requests[0]?.path).toBe('/v1/models')
  })
})
