import { describe, expect, test } from 'vitest'
import {
  decryptSensitiveMcpEnv,
  decryptSensitiveMcpEnvWithIssues,
  encryptSensitiveMcpEnv,
  hasEncryptedMcpEnv,
  maskSensitiveMcpEnvForView,
  mergeMaskedMcpEnv,
  isSensitiveMcpEnvKey
} from './settingsSecrets'
import type { McpServerEntry } from './mcpServers'

const server = (env: Record<string, string>): McpServerEntry => ({
  id: 'gmail',
  name: 'gmail',
  command: 'node',
  args: [],
  env,
  enabled: true
})

describe('settings secret helpers', () => {
  test('classifies common MCP secret env keys without treating client ids as secret', () => {
    expect(isSensitiveMcpEnvKey('ZSPARK_GMAIL_CLIENT_SECRET')).toBe(true)
    expect(isSensitiveMcpEnvKey('ZSPARK_GMAIL_REFRESH_TOKEN')).toBe(true)
    expect(isSensitiveMcpEnvKey('API_KEY')).toBe(true)
    expect(isSensitiveMcpEnvKey('ZSPARK_GMAIL_CLIENT_ID')).toBe(false)
  })

  test('encrypts and decrypts only sensitive MCP env values', () => {
    const encrypted = encryptSensitiveMcpEnv([
      server({
        ZSPARK_GMAIL_CLIENT_ID: 'client-id',
        ZSPARK_GMAIL_CLIENT_SECRET: 'secret',
        ZSPARK_GMAIL_REFRESH_TOKEN: 'refresh-token'
      })
    ], (value) => Buffer.from(`sealed:${value}`).toString('base64'))

    expect(encrypted[0].env.ZSPARK_GMAIL_CLIENT_ID).toBe('client-id')
    expect(encrypted[0].env.ZSPARK_GMAIL_CLIENT_SECRET).toMatch(/^enc:v1:/)
    expect(encrypted[0].env.ZSPARK_GMAIL_REFRESH_TOKEN).toMatch(/^enc:v1:/)
    expect(hasEncryptedMcpEnv(encrypted)).toBe(true)

    const decrypted = decryptSensitiveMcpEnv(encrypted, (value) => (
      Buffer.from(value, 'base64').toString('utf8').replace(/^sealed:/, '')
    ))
    expect(decrypted[0].env).toEqual({
      ZSPARK_GMAIL_CLIENT_ID: 'client-id',
      ZSPARK_GMAIL_CLIENT_SECRET: 'secret',
      ZSPARK_GMAIL_REFRESH_TOKEN: 'refresh-token'
    })
  })

  test('keeps healthy MCP env secrets when one encrypted value cannot decrypt', () => {
    const [broken, healthy] = [
      server({
        ZSPARK_GMAIL_CLIENT_SECRET: 'enc:v1:bad',
        ZSPARK_GMAIL_REFRESH_TOKEN: 'enc:v1:good'
      }),
      { ...server({ API_KEY: 'enc:v1:ok' }), id: 'other', name: 'other' }
    ]
    const result = decryptSensitiveMcpEnvWithIssues([broken, healthy], (value) => {
      if (value === 'bad') throw new Error('bad decrypt')
      return `plain-${value}`
    })

    expect(result.servers.map((entry) => entry.env)).toEqual([
      {
        ZSPARK_GMAIL_CLIENT_SECRET: '',
        ZSPARK_GMAIL_REFRESH_TOKEN: 'plain-good'
      },
      { API_KEY: 'plain-ok' }
    ])
    expect(result.issues).toEqual([
      {
        serverId: 'gmail',
        serverName: 'gmail',
        key: 'ZSPARK_GMAIL_CLIENT_SECRET',
        error: 'bad decrypt'
      }
    ])
  })

  test('keeps existing secrets when renderer saves a masked MCP env view', () => {
    const current = [server({ ZSPARK_GMAIL_CLIENT_SECRET: 'secret-token', LABEL: 'plain' })]
    const masked = maskSensitiveMcpEnvForView(current)
    expect(masked[0].env.ZSPARK_GMAIL_CLIENT_SECRET).toBe('secr••••oken')

    const merged = mergeMaskedMcpEnv(current, masked)
    expect(merged[0].env).toEqual({ ZSPARK_GMAIL_CLIENT_SECRET: 'secret-token', LABEL: 'plain' })

    const edited = mergeMaskedMcpEnv(current, [
      server({ ZSPARK_GMAIL_CLIENT_SECRET: 'new-secret', LABEL: 'plain' })
    ])
    expect(edited[0].env.ZSPARK_GMAIL_CLIENT_SECRET).toBe('new-secret')
  })
})
