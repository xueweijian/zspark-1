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
  /**
   * When set to 'responses' (or when baseUrl ends with `/responses`), the
   * bridge forwards `/v1/responses` requests verbatim instead of translating
   * to chat-completions. This preserves `reasoning` items so the upstream
   * Responses API can pair function_call ↔ reasoning across turns (the
   * Responses API rejects orphaned function_call items with
   * "provided without its required 'reasoning' item").
   */
  mode?: 'chat' | 'responses'
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

function buildUpstreamUrl(rawBaseUrl: string, endpoint: typeof CHAT_COMPLETIONS_SUFFIX | typeof MODELS_SUFFIX | typeof RESPONSES_SUFFIX): URL {
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


function isResponsesUpstream(cfg: UpstreamConfig): boolean {
  if (cfg.mode === 'responses') return true
  try {
    const path = new URL(cfg.baseUrl.trim()).pathname.replace(/\/+$/, '')
    return path.endsWith(RESPONSES_SUFFIX)
  } catch {
    return false
  }
}

interface OrphanedFunctionCallError {
  functionCallId: string
  reasoningId: string | null
}

/**
 * Parse the OpenAI Responses error message:
 *   "Item 'fc_...' of type 'function_call' was provided without its
 *    required 'reasoning' item: 'rs_...'."
 */
function extractOrphanedFunctionCallError(raw: string): OrphanedFunctionCallError | null {
  const match = raw.match(/Item '([^']+)' of type 'function_call' was provided without its required 'reasoning' item(?:: '([^']+)')?/)
  return match ? { functionCallId: match[1], reasoningId: match[2] ?? null } : null
}

function isFunctionCallMatch(item: any, fcIdentifier: string): boolean {
  if (item?.type !== 'function_call') return false
  return item.id === fcIdentifier || item.call_id === fcIdentifier
}

function reasoningItemHasModelPayload(item: any): boolean {
  if (item?.type !== 'reasoning') return false
  if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) return true
  if (Array.isArray(item.summary) && item.summary.length > 0) return true
  return Array.isArray(item.content) && item.content.length > 0
}

function moveExistingReasoningBeforeFunctionCall(
  payload: any,
  fcIdentifier: string,
  reasoningId: string
): { payload: any; moved: boolean } {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.input)) {
    return { payload, moved: false }
  }
  const input = [...payload.input]
  const reasoningIndex = input.findIndex((item: any) => item?.type === 'reasoning' && item.id === reasoningId)
  const callIndex = input.findIndex((item: any) => isFunctionCallMatch(item, fcIdentifier))
  if (reasoningIndex < 0 || callIndex < 0) return { payload, moved: false }
  const reasoning = input[reasoningIndex]
  if (!reasoningItemHasModelPayload(reasoning)) return { payload, moved: false }
  if (reasoningIndex === callIndex - 1) return { payload, moved: false }
  input.splice(reasoningIndex, 1)
  const adjustedCallIndex = reasoningIndex < callIndex ? callIndex - 1 : callIndex
  input.splice(adjustedCallIndex, 0, reasoning)
  return { payload: { ...payload, input }, moved: true }
}

function stripFunctionCall(
  payload: any,
  fcIdentifier: string,
  reasoningId?: string | null
): { payload: any; dropped: boolean } {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.input)) {
    return { payload, dropped: false }
  }
  const items: any[] = payload.input
  const orphanedCallIds = new Set<string>()
  let dropped = false
  for (const item of items) {
    if (isFunctionCallMatch(item, fcIdentifier)) {
      if (typeof item.call_id === 'string') orphanedCallIds.add(item.call_id)
      dropped = true
    }
  }
  if (!dropped) return { payload, dropped: false }
  const filtered = items.filter((item) => {
    if (isFunctionCallMatch(item, fcIdentifier)) return false
    if (reasoningId && item?.type === 'reasoning' && item.id === reasoningId) return false
    if (item?.type === 'function_call_output' && typeof item.call_id === 'string' && orphanedCallIds.has(item.call_id)) {
      return false
    }
    return true
  })
  return { payload: { ...payload, input: filtered }, dropped: true }
}

function recoverOrphanedFunctionCall(
  payload: any,
  error: OrphanedFunctionCallError
): { payload: any; recovered: boolean } {
  if (error.reasoningId) {
    const moved = moveExistingReasoningBeforeFunctionCall(payload, error.functionCallId, error.reasoningId)
    if (moved.moved) return { payload: moved.payload, recovered: true }
  }
  const stripped = stripFunctionCall(payload, error.functionCallId, error.reasoningId)
  return { payload: stripped.payload, recovered: stripped.dropped }
}

const MAX_RESPONSES_RETRY_ATTEMPTS = 16

function sendResponsesRequest(
  cfg: UpstreamConfig,
  body: Buffer,
  stream: boolean,
  onResponse: (res: ClientResponse) => void,
  onError: (err: Error) => void,
  registerReq: (req: ClientRequest) => void
) {
  const u = buildUpstreamUrl(cfg.baseUrl, RESPONSES_SUFFIX)
  const reqLib = requestLibForUrl(u)
  const upstreamReq = reqLib({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      accept: stream ? 'text/event-stream' : 'application/json'
    }
  }, onResponse)
  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error('upstream timeout'))
  })
  upstreamReq.on('error', onError)
  registerReq(upstreamReq)
  upstreamReq.write(body)
  upstreamReq.end()
}

async function handleResponsesPassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: UpstreamConfig,
  body: Buffer
) {
  // Sniff the original payload once. We only ever rebuild it when we have
  // to retry after a 400 reasoning-orphan rejection.
  let payload: any = null
  let stream = false
  try {
    payload = JSON.parse(body.toString('utf8'))
    stream = payload?.stream === true
  } catch {}

  let upstreamDone = false
  let activeReq: ClientRequest | null = null
  const abortUpstream = () => {
    if (!upstreamDone) activeReq?.destroy(new Error('downstream closed'))
  }
  req.on('aborted', abortUpstream)
  res.on('close', () => {
    if (!upstreamDone && !res.writableEnded) abortUpstream()
  })

  let activeAttempt = 0
  const attempt = (currentBody: Buffer, attemptIndex: number): void => {
    const attemptToken = ++activeAttempt
    upstreamDone = false
    sendResponsesRequest(
      cfg,
      currentBody,
      stream,
      (upstreamRes) => {
        const markDone = () => {
          if (activeAttempt === attemptToken) upstreamDone = true
        }
        upstreamRes.on('end', markDone)
        upstreamRes.on('close', markDone)
        const status = upstreamRes.statusCode ?? 502
        // Only intercept 400s — they're the only ones that carry the
        // reasoning-orphan error. Buffer the body so we can sniff it.
        if (status === 400 && payload && attemptIndex < MAX_RESPONSES_RETRY_ATTEMPTS) {
          const chunks: Buffer[] = []
          upstreamRes.on('data', (c) => chunks.push(c))
          upstreamRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            const orphanError = extractOrphanedFunctionCallError(raw)
            if (orphanError) {
              const recovered = recoverOrphanedFunctionCall(payload, orphanError)
              if (recovered.recovered) {
                payload = recovered.payload
                const nextBody = Buffer.from(JSON.stringify(recovered.payload), 'utf8')
                attempt(nextBody, attemptIndex + 1)
                return
              }
            }
            // Couldn't recover — forward the original 400 verbatim.
            if (responseWritable(res)) {
              res.writeHead(status, upstreamRes.headers as any)
              res.end(raw)
            }
          })
          upstreamRes.on('error', () => {
            if (responseWritable(res)) writeJsonError(res, 502, 'upstream error')
          })
          return
        }
        if (responseWritable(res)) {
          res.writeHead(status, upstreamRes.headers as any)
          upstreamRes.pipe(res)
        } else {
          upstreamRes.resume()
        }
      },
      (err) => {
        if (activeAttempt !== attemptToken) return
        upstreamDone = true
        if (String(err.message).includes('downstream closed')) return
        if (responseWritable(res)) {
          writeJsonError(res, 502, `upstream error: ${err.message}`)
        }
      },
      (req) => { activeReq = req }
    )
  }

  attempt(body, 0)
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, authToken?: string) {
  if (!isAuthorized(req, authToken)) { writeJsonError(res, 401, 'unauthorized'); return }
  const cfg = upstream
  if (!cfg) { res.writeHead(503).end('upstream not configured'); return }
  const body = await readBody(req)
  if (isResponsesUpstream(cfg)) {
    await handleResponsesPassthrough(req, res, cfg, body)
    return
  }
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
