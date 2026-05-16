import { randomUUID } from 'node:crypto'

/**
 * Pure helpers used by the Chat ↔ Responses bridge.
 *
 * Everything here is side-effect free: no network, no upstream state, no
 * mutable globals. This makes the translation layer trivially unit-testable
 * and keeps `bridge.ts` focused on the wire/HTTP layer.
 */

export interface FunctionCallState {
  id: string
  name: string
  argsBuf: string
  itemId: string
  outputIndex: number
  /**
   * Whether `response.output_item.added` has been emitted yet. Streaming
   * tool-call accumulators defer the announce until they have a non-empty
   * function name to avoid binding codex's call_id to "".
   */
  added?: boolean
}

export interface ResponseContext {
  responseId: string
  itemId: string
  createdAt: number
  model: string
}

export function genId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function contentToText(content: any): string {
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

export function toolOutputToText(output: any): string {
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

export function messageItem(ctx: ResponseContext, text: string, status: 'in_progress' | 'completed') {
  return {
    id: ctx.itemId,
    type: 'message',
    role: 'assistant',
    status,
    content: status === 'completed' ? [{ type: 'output_text', text }] : []
  }
}

export function functionCallItem(call: FunctionCallState) {
  return {
    id: call.itemId,
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: call.argsBuf
  }
}

export function chatErrorMessage(statusCode: number | undefined, body: Buffer): string {
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

export function chatMessageResult(json: any): { text: string; toolCalls: FunctionCallState[]; reasoning: string } {
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

export function responsesUsageFromChat(usage: any) {
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

/**
 * Convert Responses-API `input` to chat-completions `messages`.
 * `input` can be a string OR an array of items (message | function_call |
 * function_call_output | reasoning).
 */
export function inputToMessages(input: any): any[] {
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
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      msgs.push({ role: 'tool', tool_call_id: item.call_id, content: toolOutputToText(item.output) })
    }
    // reasoning items: drop (chat models don't accept them as input)
  }
  return msgs
}

export function toolsToChat(tools: any[] | undefined): any[] | undefined {
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
