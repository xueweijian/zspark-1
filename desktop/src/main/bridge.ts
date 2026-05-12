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
  baseUrl: string  // e.g. http://40.162.41.233:8001/v1 or .../chat/completions
  apiKey: string
}

let upstream: UpstreamConfig | null = null
export function setUpstream(cfg: UpstreamConfig | null) { upstream = cfg }

function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true
  return req.headers.authorization === `Bearer ${authToken}`
}

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

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'
const RESPONSES_SUFFIX = '/responses'
const MODELS_SUFFIX = '/models'

function buildUpstreamUrl(rawBaseUrl: string, endpoint: typeof CHAT_COMPLETIONS_SUFFIX | typeof MODELS_SUFFIX): URL {
  const url = new URL(rawBaseUrl.trim())
  let path = url.pathname.replace(/\/+$/, '')
  for (const suffix of [CHAT_COMPLETIONS_SUFFIX, RESPONSES_SUFFIX, MODELS_SUFFIX]) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, '')
      break
    }
  }
  url.pathname = `${path}${endpoint}`
  return url
}

function requestLibForUrl(url: URL) {
  return url.protocol === 'https:' ? httpsRequest : httpRequest
}

function responseHeaders(stream: boolean) {
  return stream
    ? { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
    : { 'content-type': 'application/json' }
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      return part.text ?? part.content ?? ''
    })
    .filter(Boolean)
    .join('')
}

function toolOutputToText(output: any): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return output == null ? '' : JSON.stringify(output)
  return output
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      return part.text ?? part.content ?? ''
    })
    .filter(Boolean)
    .join('\n')
}

interface FunctionCallState {
  id: string
  name: string
  argsBuf: string
  itemId: string
  outputIndex: number
}

interface ResponseContext {
  responseId: string
  itemId: string
  createdAt: number
  model: string
}

function messageItem(ctx: ResponseContext, text: string, status: 'in_progress' | 'completed') {
  return {
    id: ctx.itemId,
    type: 'message',
    role: 'assistant',
    status,
    content: status === 'completed' ? [{ type: 'output_text', text }] : []
  }
}

function functionCallItem(call: FunctionCallState) {
  return {
    id: call.itemId,
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: call.argsBuf
  }
}

function chatErrorMessage(statusCode: number | undefined, body: Buffer): string {
  const prefix = statusCode ? `upstream returned HTTP ${statusCode}` : 'upstream error'
  const text = body.toString('utf8').trim()
  if (!text) return prefix
  try {
    const json = JSON.parse(text)
    const message = json?.error?.message ?? json?.message ?? json?.detail
    if (message) return `${prefix}: ${message}`
  } catch {}
  return `${prefix}: ${text.slice(0, 1000)}`
}

function writeResponseFailed(res: ServerResponse, ctx: ResponseContext, message: string) {
  if (!res.headersSent) {
    res.writeHead(200, responseHeaders(true))
  }
  sseWrite(res, 'response.failed', {
    type: 'response.failed',
    response: {
      id: ctx.responseId,
      object: 'response',
      created_at: ctx.createdAt,
      model: ctx.model,
      status: 'failed',
      error: { type: 'server_error', code: 'upstream_error', message }
    }
  })
  res.end()
}

function writeJsonError(res: ServerResponse, statusCode: number, message: string) {
  res.writeHead(statusCode, responseHeaders(false))
  res.end(JSON.stringify({ error: { message } }))
}

function chatMessageResult(json: any): { text: string; toolCalls: FunctionCallState[]; reasoning: string } {
  const choice = json?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const text = contentToText(message.content)
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((tc: any, index: number) => ({
      id: tc.id ?? genId('call'),
      name: tc.function?.name ?? '',
      argsBuf: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '',
      itemId: genId('fc'),
      outputIndex: index + 1
    }))
    : []
  return { text, toolCalls, reasoning }
}

function responsesUsageFromChat(usage: any) {
  if (!usage || typeof usage !== 'object') return undefined
  if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' && typeof usage.total_tokens === 'number') {
    return usage
  }

  const inputTokens = usage.prompt_tokens
  const outputTokens = usage.completion_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined

  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens
  }
}

function emitChatJsonAsResponsesSse(res: ServerResponse, ctx: ResponseContext, json: any) {
  const result = chatMessageResult(json)
  let nextOutputIndex = 1
  if (result.reasoning) {
    const reasoningItemId = genId('rs')
    const outputIndex = nextOutputIndex++
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { id: reasoningItemId, type: 'reasoning', summary: [], content: [] }
    })
    sseWrite(res, 'response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningItemId,
      output_index: outputIndex,
      summary_index: 0,
      delta: result.reasoning
    })
    sseWrite(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { id: reasoningItemId, type: 'reasoning', summary: [], content: [] }
    })
  }

  if (result.text) {
    sseWrite(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: ctx.itemId,
      output_index: 0,
      content_index: 0,
      delta: result.text
    })
  }

  for (const call of result.toolCalls) {
    call.outputIndex = nextOutputIndex++
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: call.outputIndex,
      item: { ...functionCallItem(call), arguments: '' }
    })
    if (call.argsBuf) {
      sseWrite(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: call.itemId,
        output_index: call.outputIndex,
        delta: call.argsBuf
      })
    }
    sseWrite(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: call.outputIndex,
      item: functionCallItem(call)
    })
  }

  const output = [
    messageItem(ctx, result.text, 'completed'),
    ...result.toolCalls.map(functionCallItem)
  ]
  sseWrite(res, 'response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: output[0]
  })
  sseWrite(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: ctx.responseId,
      object: 'response',
      created_at: ctx.createdAt,
      model: ctx.model,
      status: 'completed',
      output,
      usage: responsesUsageFromChat(json.usage)
    }
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeChatJsonAsResponsesJson(res: ServerResponse, ctx: ResponseContext, json: any) {
  const result = chatMessageResult(json)
  res.writeHead(200, responseHeaders(false))
  res.end(JSON.stringify({
    id: ctx.responseId,
    object: 'response',
    created_at: ctx.createdAt,
    model: ctx.model,
    status: 'completed',
    output: [
      messageItem(ctx, result.text, 'completed'),
      ...result.toolCalls.map(functionCallItem)
    ],
    usage: responsesUsageFromChat(json.usage)
  }))
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
      const rawRole = item.role ?? 'user'
      const role = rawRole === 'developer' ? 'system' : rawRole
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
      msgs.push({ role: 'tool', tool_call_id: item.call_id, content: toolOutputToText(item.output) })
    } else if (item.type === 'custom_tool_call_output') {
      msgs.push({ role: 'tool', tool_call_id: item.call_id, content: toolOutputToText(item.output) })
    }
    // reasoning items: drop (chat models don't accept them as input)
  }
  return msgs
}

function toolsToChat(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = tools.flatMap((t: any) => {
    if (t.type !== 'function') return []
    if (t.function?.name) return [{ type: 'function', function: t.function }]
    if (t.name) {
      return [{
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? t.input_schema ?? { type: 'object' }
        }
      }]
    }
    return []
  })
  return out.length ? out : undefined
}

function genId(prefix: string) { return `${prefix}_${Math.random().toString(16).slice(2, 18)}` }

async function handleResponses(req: IncomingMessage, res: ServerResponse, authToken?: string) {
  if (!isAuthorized(req, authToken)) { writeJsonError(res, 401, 'unauthorized'); return }
  if (!upstream) { res.writeHead(503).end('upstream not configured'); return }
  const body = await readBody(req)
  let payload: any
  try { payload = JSON.parse(body.toString('utf8')) } catch { res.writeHead(400).end('bad json'); return }

  const stream = payload.stream !== false  // default true
  const chatTools = toolsToChat(payload.tools)
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
    tools: chatTools,
    tool_choice: chatTools ? payload.tool_choice : undefined,
    parallel_tool_calls: chatTools ? payload.parallel_tool_calls : undefined
  }
  // Strip undefined to avoid choking strict providers
  for (const k of Object.keys(chatBody)) if (chatBody[k] === undefined) delete chatBody[k]

  const u = buildUpstreamUrl(upstream.baseUrl, CHAT_COMPLETIONS_SUFFIX)
  const reqLib = requestLibForUrl(u)
  const responseId = genId('resp')
  const itemId = genId('msg')
  const createdAt = Math.floor(Date.now() / 1000)
  const ctx: ResponseContext = { responseId, itemId, createdAt, model: payload.model }

  // SSE response to codex
  if (stream) {
    res.writeHead(200, responseHeaders(true))
    sseWrite(res, 'response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: createdAt, model: payload.model, status: 'in_progress', output: [] }
    })
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: messageItem(ctx, '', 'in_progress')
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
        const raw = Buffer.concat(chunks)
        const statusCode = upstreamRes.statusCode ?? 502
        if (statusCode < 200 || statusCode >= 300) {
          writeJsonError(res, statusCode, chatErrorMessage(statusCode, raw))
          return
        }
        try {
          writeChatJsonAsResponsesJson(res, ctx, JSON.parse(raw.toString('utf8')))
        } catch (e) {
          res.writeHead(502).end('upstream parse error')
        }
      })
      return
    }
    // Streaming path: parse upstream SSE and emit response.* events
    const statusCode = upstreamRes.statusCode ?? 502
    const contentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase()
    if (statusCode < 200 || statusCode >= 300 || contentType.includes('application/json')) {
      const chunks: Buffer[] = []
      upstreamRes.on('data', (c) => chunks.push(c))
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks)
        if (statusCode < 200 || statusCode >= 300) {
          writeResponseFailed(res, ctx, chatErrorMessage(statusCode, raw))
          return
        }
        try {
          emitChatJsonAsResponsesSse(res, ctx, JSON.parse(raw.toString('utf8')))
        } catch {
          writeResponseFailed(res, ctx, 'upstream parse error')
        }
      })
      upstreamRes.on('error', (err) => {
        writeResponseFailed(res, ctx, `upstream error: ${err.message}`)
      })
      return
    }

    let buf = ''
    let textAcc = ''
    let reasoningOpen = false
    let reasoningItemId = genId('rs')
    let reasoningOutputIndex: number | null = null
    let toolCalls: Map<number, FunctionCallState> = new Map()
    let nextOutputIndex = 1 // 0 is the message item
    let completed = false

    const finalize = () => {
      if (completed) return
      completed = true
      if (reasoningOpen) {
        sseWrite(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: reasoningOutputIndex ?? 1,
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
        item: messageItem(ctx, textAcc, 'completed')
      })
      const output = [
        messageItem(ctx, textAcc, 'completed'),
        ...Array.from(toolCalls.values()).map(functionCallItem)
      ]
      sseWrite(res, 'response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: createdAt, model: payload.model,
          status: 'completed',
          output
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
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (!data) continue
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
            reasoningOutputIndex = nextOutputIndex
            sseWrite(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: reasoningOutputIndex,
              item: { id: reasoningItemId, type: 'reasoning', summary: [], content: [] }
            })
            nextOutputIndex++
          }
          sseWrite(res, 'response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0, delta: reasoning
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
    if (stream) {
      writeResponseFailed(res, ctx, `upstream error: ${e.message}`)
    } else {
      writeJsonError(res, 502, `upstream error: ${e.message}`)
    }
  })
  upstreamReq.write(JSON.stringify(chatBody))
  upstreamReq.end()
}

export function startBridge(authToken?: string): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    if (!req.url) { res.writeHead(404).end(); return }
    if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
      handleResponses(req, res, authToken).catch((e) => { res.writeHead(500).end(e?.message ?? 'error') })
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      // Forward to upstream so codex can probe model availability
      if (!isAuthorized(req, authToken)) { writeJsonError(res, 401, 'unauthorized'); return }
      if (!upstream) { res.writeHead(503).end(); return }
      const u = buildUpstreamUrl(upstream.baseUrl, MODELS_SUFFIX)
      const reqLib = requestLibForUrl(u)
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
