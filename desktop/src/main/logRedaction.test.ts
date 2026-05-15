import { describe, expect, test } from 'vitest'
import { redactProcessArgsForLog, redactSensitiveLogLine, redactSensitiveLogText, redactSensitiveValue } from './logRedaction'

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
    expect(redactSensitiveValue({ provider: { apiKey: 'sk-live', clientId: 'gmail-client-id', model: 'x' } })).toEqual({
      provider: { apiKey: '[redacted]', clientId: '[redacted]', model: 'x' }
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

  test('redacts secret assignments embedded in legacy plain-text log lines', () => {
    const line = 'spawn args=["-c","mcp_servers={ gmail = { env = { ZSPARK_GMAIL_CLIENT_ID = \\"client-id\\", ZSPARK_GMAIL_CLIENT_SECRET = \\"client-secret\\", ZSPARK_GMAIL_REFRESH_TOKEN = \\"refresh-token\\" } } }"]'

    const redacted = redactSensitiveLogLine(line)

    expect(redacted).toContain('ZSPARK_GMAIL_CLIENT_ID = \\"[redacted]\\"')
    expect(redacted).toContain('ZSPARK_GMAIL_CLIENT_SECRET = \\"[redacted]\\"')
    expect(redacted).toContain('ZSPARK_GMAIL_REFRESH_TOKEN = \\"[redacted]\\"')
    expect(redacted).not.toContain('client-id')
    expect(redacted).not.toContain('client-secret')
    expect(redacted).not.toContain('refresh-token')
  })

  test('redacts multi-line legacy log text while preserving line breaks', () => {
    expect(redactSensitiveLogText('one\nrefresh_token = "secret"\n')).toBe('one\nrefresh_token = "[redacted]"\n')
  })
})
