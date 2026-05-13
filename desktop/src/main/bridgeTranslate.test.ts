import { describe, expect, test } from 'vitest'
import {
  chatErrorMessage,
  chatMessageResult,
  contentToText,
  inputToMessages,
  responsesUsageFromChat,
  toolOutputToText,
  toolsToChat
} from './bridgeTranslate'

describe('contentToText', () => {
  test('passes through strings and concatenates parts', () => {
    expect(contentToText('hello')).toBe('hello')
    expect(contentToText([{ text: 'a' }, { text: 'b' }, 'c'])).toBe('abc')
    expect(contentToText(null as any)).toBe('')
  })
})

describe('toolOutputToText', () => {
  test('handles strings, arrays, and JSON fallbacks', () => {
    expect(toolOutputToText('plain')).toBe('plain')
    expect(toolOutputToText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb')
    expect(toolOutputToText({ a: 1 })).toBe('{"a":1}')
    expect(toolOutputToText(null)).toBe('')
  })
})

describe('inputToMessages', () => {
  test('wraps string input as a user message', () => {
    expect(inputToMessages('hi')).toEqual([{ role: 'user', content: 'hi' }])
  })
  test('translates function_call/function_call_output items', () => {
    const msgs = inputToMessages([
      { type: 'function_call', call_id: 'c1', name: 'do_thing', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' }
    ])
    expect(msgs).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'do_thing', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' }
    ])
  })
})

describe('toolsToChat', () => {
  test('normalises responses-style tools to chat tool schema', () => {
    expect(toolsToChat([{ type: 'function', name: 'foo', description: 'd', parameters: { type: 'object' } }]))
      .toEqual([{ type: 'function', function: { name: 'foo', description: 'd', parameters: { type: 'object' } } }])
  })
  test('returns undefined when tools list is empty', () => {
    expect(toolsToChat(undefined)).toBeUndefined()
    expect(toolsToChat([])).toBeUndefined()
  })
})

describe('chatErrorMessage', () => {
  test('extracts upstream error.message when JSON', () => {
    expect(chatErrorMessage(401, Buffer.from('{"error":{"message":"bad key"}}')))
      .toBe('upstream returned HTTP 401: bad key')
  })
  test('falls back to raw text', () => {
    expect(chatErrorMessage(500, Buffer.from('boom'))).toBe('upstream returned HTTP 500: boom')
  })
})

describe('responsesUsageFromChat', () => {
  test('translates prompt/completion tokens', () => {
    expect(responsesUsageFromChat({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      .toEqual({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15
      })
  })
  test('passes through native responses-shape usage', () => {
    const usage = { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
    expect(responsesUsageFromChat(usage)).toBe(usage)
  })
  test('returns undefined when missing required tokens', () => {
    expect(responsesUsageFromChat({})).toBeUndefined()
  })
})

describe('chatMessageResult', () => {
  test('extracts text + tool_calls + reasoning', () => {
    const result = chatMessageResult({
      choices: [{
        message: {
          content: 'hi',
          reasoning_content: 'thinking',
          tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }]
        }
      }]
    })
    expect(result.text).toBe('hi')
    expect(result.reasoning).toBe('thinking')
    expect(result.toolCalls[0].id).toBe('t1')
    expect(result.toolCalls[0].name).toBe('f')
  })
})
