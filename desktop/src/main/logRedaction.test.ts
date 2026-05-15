import { describe, expect, test } from 'vitest'
import { redactProcessArgsForLog, redactSensitiveLogLine, redactSensitiveValue } from './logRedaction'

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

  test('redacts MCP server config from logged spawn args', () => {
    expect(redactProcessArgsForLog([
      '-c',
      'mcp_servers={ gmail = { env = { ZSPARK_GMAIL_CLIENT_SECRET = "secret" } } }',
      '-c',
      'model="gpt-5.4"'
    ])).toEqual([
      '-c',
      'mcp_servers=[redacted]',
      '-c',
      'model="gpt-5.4"'
    ])
  })
})
