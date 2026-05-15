import { describe, expect, test } from 'vitest'
import {
  decryptSensitiveMcpEnv,
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
