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
import type { ClientRequest, IncomingMessage as ClientResponse } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { URL } from 'node:url'
import {
  chatErrorMessage,
  chatMessageResult,
  functionCallItem,
  genId,
  inputToMessages,
  messageItem,
  responsesUsageFromChat,
  toolsToChat,
  type FunctionCallState,
  type ResponseContext
} from './bridgeTranslate'

interface UpstreamConfig {
  baseUrl: string  // e.g. http://40.162.41.233:8001/v1 or .../chat/completions
  apiKey: string
}

let upstream: UpstreamConfig | null = null
export function setUpstream(cfg: UpstreamConfig | null) { upstream = cfg }

const UPSTREAM_TIMEOUT_MS = 120_000

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

function responseWritable(res: ServerResponse) {
  return !res.destroyed && !res.writableEnded
}

function writeIfOpen(res: ServerResponse, chunk: string | Buffer) {
  if (!responseWritable(res)) return false
  return res.write(chunk)
}

function endIfOpen(res: ServerResponse, chunk?: string | Buffer) {
  if (!responseWritable(res)) return
  res.end(chunk)
}

function sseWrite(res: ServerResponse, event: string, data: any) {
  return writeIfOpen(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sseDone(res: ServerResponse) {
  writeIfOpen(res, 'data: [DONE]\n\n')
  endIfOpen(res)
}

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'
const RESPONSES_SUFFIX = '/responses'
const MODELS_SUFFIX = '/models'

function buildUpstreamUrl(rawBaseUrl: string, endpoint: typeof CHAT_COMPLETIONS_SUFFIX | typeof MODELS_SUFFIX): URL {
  const url = new URL(rawBaseUrl.trim())
  let path = url.pathname.replace(/\/+$/, '')
  // Strip endpoint suffixes idempotently — a poorly-typed base URL like
  // `…/v1/responses/chat/completions` should still resolve to the v1 root
  // before we re-append the requested endpoint.
  for (let i = 0; i < 3; i++) {
    let stripped = false
    for (const suffix of [CHAT_COMPLETIONS_SUFFIX, RESPONSES_SUFFIX, MODELS_SUFFIX]) {
      if (path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length).replace(/\/+$/, '')
        stripped = true
        break
      }
    }
    if (!stripped) break
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

function reasoningItem(itemId: string, text = '') {
  // Persist the reasoning text in the item summary so consumers replaying
  // the response (non-streaming JSON path, codex history snapshots) still
  // see the model's chain-of-thought instead of an empty placeholder.
  const summary = text ? [{ type: 'summary_text', text }] : []
  return { id: itemId, type: 'reasoning', summary, content: [] }
}

function writeResponseFailed(res: ServerResponse, ctx: ResponseContext, message: string) {
  if (!responseWritable(res)) return
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
  endIfOpen(res)
}

function writeJsonError(res: ServerResponse, statusCode: number, message: string) {
  if (!responseWritable(res)) return
  res.writeHead(statusCode, responseHeaders(false))
  endIfOpen(res, JSON.stringify({ error: { message } }))
}



function emitChatJsonAsResponsesSse(res: ServerResponse, ctx: ResponseContext, json: any) {
  const result = chatMessageResult(json)
  let nextOutputIndex = 1
  let reasoningItemId: string | null = null
  if (result.reasoning) {
    reasoningItemId = genId('rs')
    const outputIndex = nextOutputIndex++
    sseWrite(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: reasoningItem(reasoningItemId)
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
      item: reasoningItem(reasoningItemId, result.reasoning)
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
    ...(reasoningItemId ? [reasoningItem(reasoningItemId, result.reasoning)] : []),
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
  sseDone(res)
}

function writeChatJsonAsResponsesJson(res: ServerResponse, ctx: ResponseContext, json: any) {
  const result = chatMessageResult(json)
  const reasoningItemId = result.reasoning ? genId('rs') : null
  if (!responseWritable(res)) return
  res.writeHead(200, responseHeaders(false))
  endIfOpen(res, JSON.stringify({
    id: ctx.responseId,
    object: 'response',
    created_at: ctx.createdAt,
    model: ctx.model,
    status: 'completed',
    output: [
      messageItem(ctx, result.text, 'completed'),
      ...(reasoningItemId ? [reasoningItem(reasoningItemId, result.reasoning)] : []),
      ...result.toolCalls.map(functionCallItem)
    ],
    usage: responsesUsageFromChat(json.usage)
  }))
}


async function handleResponses(req: IncomingMessage, res: ServerResponse, authToken?: string) {
  if (!isAuthorized(req, authToken)) { writeJsonError(res, 401, 'unauthorized'); return }
  const cfg = upstream
  if (!cfg) { res.writeHead(503).end('upstream not configured'); return }
  const body = await readBody(req)
  let payload: any
  try { payload = JSON.parse(body.toString('utf8')) } catch { res.writeHead(400).end('bad json'); return }

  // Honor explicit stream booleans only; default to non-streaming when the
  // caller didn't specify so we don't accidentally feed SSE to a JSON
  // consumer (codex always sends `stream: true` for chat-loop turns).
  const stream = payload.stream === true
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

  const u = buildUpstreamUrl(cfg.baseUrl, CHAT_COMPLETIONS_SUFFIX)
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

  let upstreamDone = false
  let upstreamReq: ClientRequest | null = null
  const abortUpstream = () => {
    if (!upstreamDone) upstreamReq?.destroy(new Error('downstream closed'))
  }
  req.on('aborted', abortUpstream)
  res.on('close', () => {
    if (!upstreamDone && !res.writableEnded) abortUpstream()
  })

  upstreamReq = reqLib({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      accept: stream ? 'text/event-stream' : 'application/json'
    }
  }, (upstreamRes) => {
    const markDone = () => { upstreamDone = true }
    upstreamRes.on('end', markDone)
    upstreamRes.on('close', markDone)

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
          if (responseWritable(res)) res.writeHead(502).end('upstream parse error')
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
    let reasoningAcc = ''
    let reasoningOpen = false
    let reasoningItemId = genId('rs')
    let reasoningOutputIndex: number | null = null
    let toolCalls: Map<number, FunctionCallState> = new Map()
    let nextOutputIndex = 1 // 0 is the message item
    let completed = false
    let usage: ReturnType<typeof responsesUsageFromChat> | undefined
    let finishReason: string | null = null
    const decoder = new StringDecoder('utf8')
    let waitingForDrain = false

    const pauseForBackpressure = () => {
      if (waitingForDrain || !res.writableNeedDrain) return
      waitingForDrain = true
      upstreamRes.pause()
      res.once('drain', () => {
        waitingForDrain = false
        upstreamRes.resume()
      })
    }

    const finalize = () => {
      if (completed) return
      completed = true
      if (reasoningOpen) {
        sseWrite(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: reasoningOutputIndex ?? 1,
          item: reasoningItem(reasoningItemId, reasoningAcc)
        })
      }
      for (const e of toolCalls.values()) {
        // Late-arriving names that didn't show up before the first delta:
        // emit `output_item.added` now so codex still binds the call_id to
        // the right tool name. The renderer treats matching ids as updates.
        if (!e.added && e.name) {
          sseWrite(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: e.outputIndex,
            item: { id: e.itemId, type: 'function_call', call_id: e.id, name: e.name, arguments: '' }
          })
          e.added = true
          if (e.argsBuf) {
            sseWrite(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: e.itemId, output_index: e.outputIndex, delta: e.argsBuf
            })
          }
        }
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
        ...(reasoningOpen ? [reasoningItem(reasoningItemId, reasoningAcc)] : []),
        ...Array.from(toolCalls.values()).map(functionCallItem)
      ]
      const status = finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls' && finishReason !== 'function_call'
        ? 'incomplete'
        : 'completed'
      const stopReason = finishReason === 'length'
        ? 'max_output_tokens'
        : finishReason === 'content_filter'
          ? 'content_filter'
          : undefined
      sseWrite(res, 'response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: createdAt, model: payload.model,
          status,
          ...(stopReason ? { incomplete_details: { reason: stopReason } } : {}),
          output,
          usage
        }
      })
      sseDone(res)
    }

    const processSseText = (text: string) => {
      if (completed) return
      buf += text
      const frames = buf.split(/\r?\n\r?\n/)
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        if (completed) return
        // Per the SSE spec, only one leading SPACE after `data:` is removed;
        // `.trim()` over-eagerly strips intra-JSON whitespace and corrupts
        // payloads where strings end with significant trailing spaces.
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => {
            const tail = l.slice(5)
            return tail.startsWith(' ') ? tail.slice(1) : tail
          })
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') { finalize(); return }
        let evt: any
        try { evt = JSON.parse(data) } catch { continue }
        const chunkUsage = responsesUsageFromChat(evt.usage)
        if (chunkUsage) usage = chunkUsage
        // Some providers (Azure-OpenAI) emit a `prompt_filter_results` only chunk
        if (!evt.choices || evt.choices.length === 0) continue
        const choice = evt.choices[0] ?? {}
        const delta = choice.delta ?? {}
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason
        }
        // 1. reasoning_content
        const reasoning = delta.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length) {
          if (!reasoningOpen) {
            reasoningOpen = true
            reasoningOutputIndex = nextOutputIndex
            sseWrite(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: reasoningOutputIndex,
              item: reasoningItem(reasoningItemId)
            })
            nextOutputIndex++
          }
          reasoningAcc += reasoning
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
        // 3. tool_calls — defer the `output_item.added` event until we have
        // a non-empty function name. Some providers (vLLM tool-calling
        // builds, Azure-OpenAI parallel tools) split id/name across early
        // chunks; emitting `added` with an empty name binds codex's call_id
        // to "" and breaks the tool-loop.
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0
            let entry = toolCalls.get(idx)
            if (!entry) {
              entry = {
                id: tc.id ?? genId('call'),
                name: tc.function?.name ?? '',
                argsBuf: '',
                itemId: genId('fc'),
                outputIndex: nextOutputIndex++,
                added: false
              }
              toolCalls.set(idx, entry)
            }
            if (tc.id && entry.id !== tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            const announce = !entry.added && entry.name
            if (announce) {
              sseWrite(res, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: entry.outputIndex,
                item: { id: entry.itemId, type: 'function_call', call_id: entry.id, name: entry.name, arguments: '' }
              })
              entry.added = true
            }
            if (typeof tc.function?.arguments === 'string') {
              entry.argsBuf += tc.function.arguments
              if (entry.added) {
                sseWrite(res, 'response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  item_id: entry.itemId, output_index: entry.outputIndex, delta: tc.function.arguments
                })
              }
            }
          }
        }
      }
      pauseForBackpressure()
    }

    upstreamRes.on('data', (chunk: Buffer) => {
      processSseText(decoder.write(chunk))
    })
    upstreamRes.on('end', () => {
      const rest = decoder.end()
      if (rest) processSseText(rest)
      finalize()
    })
    upstreamRes.on('error', () => { finalize() })
  })
  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamReq?.destroy(new Error('upstream timeout'))
  })
  upstreamReq.on('error', (e) => {
    upstreamDone = true
    if (String(e.message).includes('downstream closed')) return
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
      const cfg = upstream
      if (!cfg) { res.writeHead(503).end(); return }
      const u = buildUpstreamUrl(cfg.baseUrl, MODELS_SUFFIX)
      const reqLib = requestLibForUrl(u)
      const fwd = reqLib({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname, method: 'GET',
        headers: { authorization: `Bearer ${cfg.apiKey}` }
      }, (r: ClientResponse) => { res.writeHead(r.statusCode ?? 200, r.headers as any); r.pipe(res) })
      let forwardDone = false
      res.on('close', () => {
        if (!forwardDone && !res.writableEnded) fwd.destroy(new Error('downstream closed'))
      })
      fwd.setTimeout(UPSTREAM_TIMEOUT_MS, () => fwd.destroy(new Error('upstream timeout')))
      fwd.on('close', () => { forwardDone = true })
      fwd.on('error', () => {
        if (responseWritable(res)) res.writeHead(502).end()
      })
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
