/**
 * In-process Chat-Completions ↔ Responses-API translator.
 *
 * Why: codex-rs has dropped the chat-completions wire format. Most
 * self-hosted providers (vLLM <0.7, SGLang current, AzureChatGPT-on-CN,
 * Ollama, etc.) only speak /v1/chat/completions. We bridge them so
 * zspark stays universal — codex talks Responses to localhost, we
 * translate to chat upstream.
 *
 * Surface: only `/v1/responses` (POST, streaming SSE). All other
 * endpoints proxy verbatim.
 *
 * Tooling: we map both directions:
 *   Responses tools  → chat.completions tools (OpenAI v2 tools format)
 *   chat tool_calls  → Responses output_item type=function_call
 * so codex can drive function calling against chat-only providers.
 *
 * Reasoning: if the upstream returns `reasoning_content` (Qwen3, Kimi,
 * GLM-4.6, DeepSeek-R1 dialect) we wrap each delta as a
 * `response.reasoning_summary_text.delta` event so the zspark Thinking
 * panel lights up.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { URL } from 'node:url'

interface UpstreamConfig {
  baseUrl: string  // e.g. http://40.162.41.233:8001/v1
  apiKey: string
}

let upstream: UpstreamConfig | null = null
export function setUpstream(cfg: UpstreamConfig | null) { upstream = cfg }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sseWrite(res: ServerResponse, event: string, data: any) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

interface RespMessageContent { type: string; text?: string; image_url?: any }
interface RespMessage { type: 'message'; role: string; content: RespMessageContent[] | string }

/**
 * Convert Responses-API `input` to chat-completions `messages`.
 * `input` can be a string OR an array of items (message | function_call |
 * function_call_output | reasoning).
 */
function inputToMessages(input: any): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  const msgs: any[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || item.role) {
      const role = item.role ?? 'user'
      let content: any = item.content
      if (Array.isArray(content)) {
        const text = content.map((c: any) => c.text ?? '').filter(Boolean).join('')
        const images = content.filter((c: any) => c.type === 'input_image' || c.type === 'image_url')
        if (images.length === 0) {
          content = text
        } else {
          content = [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((i: any) => ({ type: 'image_url', image_url: { url: i.image_url ?? i.url } }))
          ]
        }
      }
      msgs.push({ role, content })
    } else if (item.type === 'function_call') {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } }]
      })
    } else if (item.type === 'function_call_output') {
      msgs.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' })
    }
    // reasoning items: drop (chat models don't accept them as input)
  }
  return msgs
}

function toolsToChat(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((t: any) => {
    if (t.type === 'function' && t.function) return t
    if (t.type === 'function' && t.name) return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? t.input_schema } }
    return t
  })
}

function genId(prefix: string) { return `${prefix}_${Math.random().toString(16).slice(2, 18)}` }

async function handleResponses(req: IncomingMessage, res: ServerResponse) {
  if (!upstream) { res.writeHead(503).end('upstream not configured'); return }
  const body = await readBody(req)
  let payload: any
  try { payload = JSON.parse(body.toString('utf8')) } catch { res.writeHead(400).end('bad json'); return }

  const stream = payload.stream !== false  // default true
  const chatBody: any = {
    model: payload.model,
    messages: [
      ...(payload.instructions ? [{ role: 'system', content: payload.instructions }] : []),
      ...inputToMessages(payload.input)
    ],
    stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens ?? payload.max_tokens,
    tools: toolsToChat(payload.tools),
    tool_choice: payload.tool_choice
  }
  // Strip undefined to avoid choking strict providers
  for (const k of Object.keys(chatBody)) if (chatBody[k] === undefined) delete chatBody[k]

  const u = new URL((upstream.baseUrl.replace(/\/+$/, '')) + '/chat/completions')
  const reqLib = u.protocol === 'https:' ? httpsRequest : httpRequest
  const responseId = genId('resp')
  const itemId = genId('msg')
  const createdAt = Math.floor(Date.now() / 1000)

  // SSE response to codex
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    sseWrite(res, 'response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: createdAt, model: payload.model, status: 'in_progress', output: [] }
    })
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    })
  }

  const upstreamReq = reqLib({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${upstream.apiKey}`,
      accept: stream ? 'text/event-stream' : 'application/json'
    }
  }, (upstreamRes) => {
    if (!stream) {
      const chunks: Buffer[] = []
      upstreamRes.on('data', (c) => chunks.push(c))
      upstreamRes.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const choice = json.choices?.[0]
          const text = choice?.message?.content ?? ''
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: responseId, object: 'response', created_at: createdAt, model: payload.model,
            status: 'completed',
            output: [{ id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
            usage: json.usage
          }))
        } catch (e) {
          res.writeHead(502).end('upstream parse error')
        }
      })
      return
    }
    // Streaming path: parse upstream SSE and emit response.* events
    let buf = ''
    let textAcc = ''
    let reasoningOpen = false
    let reasoningItemId = genId('rs')
    let toolCalls: Map<number, { id: string; name: string; argsBuf: string; itemId: string; outputIndex: number }> = new Map()
    let nextOutputIndex = 1 // 0 is the message item
    let completed = false

    const finalize = () => {
      if (completed) return
      completed = true
      if (reasoningOpen) {
        sseWrite(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 1,
          item: { id: reasoningItemId, type: 'reasoning', summary: [], content: [] }
        })
      }
      for (const e of toolCalls.values()) {
        sseWrite(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: e.outputIndex,
          item: { id: e.itemId, type: 'function_call', call_id: e.id, name: e.name, arguments: e.argsBuf }
        })
      }
      sseWrite(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textAcc }] }
      })
      sseWrite(res, 'response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: createdAt, model: payload.model,
          status: 'completed',
          output: [{ id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textAcc }] }]
        }
      })
      res.write('data: [DONE]\n\n')
      res.end()
    }

    upstreamRes.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const frames = buf.split(/\r?\n\r?\n/)
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const dataLine = frame.split(/\r?\n/).find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const data = dataLine.slice(5).trim()
        if (data === '[DONE]') { finalize(); return }
        let evt: any
        try { evt = JSON.parse(data) } catch { continue }
        // Some providers (Azure-OpenAI) emit a `prompt_filter_results` only chunk
        if (!evt.choices || evt.choices.length === 0) continue
        const delta = evt.choices[0]?.delta ?? {}
        // 1. reasoning_content
        const reasoning = delta.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length) {
          if (!reasoningOpen) {
            reasoningOpen = true
            sseWrite(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: nextOutputIndex,
              item: { id: reasoningItemId, type: 'reasoning', summary: [], content: [] }
            })
            nextOutputIndex++
          }
          sseWrite(res, 'response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningItemId, output_index: nextOutputIndex - 1, summary_index: 0, delta: reasoning
          })
        }
        // 2. content delta
        const ctext = delta.content
        if (typeof ctext === 'string' && ctext.length) {
          textAcc += ctext
          sseWrite(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId, output_index: 0, content_index: 0, delta: ctext
          })
        }
        // 3. tool_calls
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0
            let entry = toolCalls.get(idx)
            if (!entry) {
              entry = { id: tc.id ?? genId('call'), name: tc.function?.name ?? '', argsBuf: '', itemId: genId('fc'), outputIndex: nextOutputIndex++ }
              toolCalls.set(idx, entry)
              sseWrite(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: entry.outputIndex,
                item: { id: entry.itemId, type: 'function_call', call_id: entry.id, name: entry.name, arguments: '' }
              })
            }
            if (tc.function?.name && !entry.name) entry.name = tc.function.name
            if (typeof tc.function?.arguments === 'string') {
              entry.argsBuf += tc.function.arguments
              sseWrite(res, 'response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: entry.itemId, output_index: entry.outputIndex, delta: tc.function.arguments
              })
            }
          }
        }
        // 4. finish_reason → finalize immediately
        if (evt.choices[0]?.finish_reason) finalize()
      }
    })
    upstreamRes.on('end', () => { finalize() })
    upstreamRes.on('error', () => { finalize() })
  })
  upstreamReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502)
    res.end(`upstream error: ${e.message}`)
  })
  upstreamReq.write(JSON.stringify(chatBody))
  upstreamReq.end()
}

export function startBridge(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    if (!req.url) { res.writeHead(404).end(); return }
    if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
      handleResponses(req, res).catch((e) => { res.writeHead(500).end(e?.message ?? 'error') })
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      // Forward to upstream so codex can probe model availability
      if (!upstream) { res.writeHead(503).end(); return }
      const u = new URL(upstream.baseUrl.replace(/\/+$/, '') + '/models')
      const reqLib = u.protocol === 'https:' ? httpsRequest : httpRequest
      const fwd = reqLib({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname, method: 'GET',
        headers: { authorization: `Bearer ${upstream.apiKey}` }
      }, (r) => { res.writeHead(r.statusCode ?? 200, r.headers as any); r.pipe(res) })
      fwd.on('error', () => res.writeHead(502).end())
      fwd.end()
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}
