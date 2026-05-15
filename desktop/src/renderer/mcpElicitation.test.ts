import { describe, expect, test } from 'vitest'
import { responseForMcpElicitationRequest } from './mcpElicitation'

describe('responseForMcpElicitationRequest', () => {
  test('accepts only empty-schema form elicitations', () => {
    expect(responseForMcpElicitationRequest({
      mode: 'form',
      requestedSchema: { type: 'object', properties: {} }
    })).toEqual({ action: 'accept', content: {} })
  })

  test('declines form elicitations that request structured input', () => {
    expect(responseForMcpElicitationRequest({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed']
      }
    })).toEqual({ action: 'decline', content: null, reason: 'structured-input' })
  })

  test('declines URL and malformed elicitations', () => {
    expect(responseForMcpElicitationRequest({ mode: 'url', url: 'https://example.com' })).toEqual({
      action: 'decline',
      content: null,
      reason: 'url'
    })
    expect(responseForMcpElicitationRequest(null)).toEqual({ action: 'decline', content: null, reason: 'malformed' })
  })
})
