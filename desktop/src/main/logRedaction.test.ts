import { describe, expect, test } from 'vitest'
import { redactSensitiveLogLine, redactSensitiveValue } from './logRedaction'

describe('log redaction', () => {
  test('redacts credential-bearing URLs and token fields from JSON logs', () => {
    const line = JSON.stringify({
      method: 'thread/read',
      params: {
        gitInfo: {
          originUrl: 'https://user:ghp_123456789012345678901234567890123456@github.com/org/repo.git'
        },
        authorization: 'Bearer sk-secret-token'
      }
    })

    expect(redactSensitiveLogLine(line)).toBe(JSON.stringify({
      method: 'thread/read',
      params: {
        gitInfo: {
          originUrl: 'https://[redacted]@github.com/org/repo.git'
        },
        authorization: '[redacted]'
      }
    }))
  })

  test('redacts nested secret-like keys', () => {
    expect(redactSensitiveValue({ provider: { apiKey: 'sk-live', model: 'x' } })).toEqual({
      provider: { apiKey: '[redacted]', model: 'x' }
    })
  })
})
