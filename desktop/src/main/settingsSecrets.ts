import type { McpServerEntry } from './mcpServers'

const ENCRYPTED_VALUE_PREFIX = 'enc:v1:'
const MASK_MARKER = '••••'
const MASKED_SECRET_RE = new RegExp(`^[^${MASK_MARKER[0]}]{0,4}${MASK_MARKER}[^${MASK_MARKER[0]}]{0,4}$`)
const SENSITIVE_MCP_ENV_KEY_RE = /(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|credential|auth)(?:_|$)|private[_-]?key/i

export interface McpSecretDecryptIssue {
  serverId: string
  serverName: string
  key: string
  error: string
}

export function isSensitiveMcpEnvKey(key: string): boolean {
  return SENSITIVE_MCP_ENV_KEY_RE.test(key)
}

function encryptedValue(value: string) {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX)
}

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return MASK_MARKER
  return `${value.slice(0, 4)}${MASK_MARKER}${value.slice(-4)}`
}

function isMaskedSecretValue(value: string): boolean {
  return MASKED_SECRET_RE.test(value)
}

function cloneMcpServers(servers: McpServerEntry[]): McpServerEntry[] {
  return servers.map((server) => ({ ...server, args: [...server.args], env: { ...server.env } }))
}

export function encryptSensitiveMcpEnv(
  servers: McpServerEntry[] | undefined,
  encrypt: (value: string) => string
): McpServerEntry[] {
  if (!servers) return []
  return cloneMcpServers(servers).map((server) => {
    for (const [key, value] of Object.entries(server.env)) {
      if (!isSensitiveMcpEnvKey(key) || !value || encryptedValue(value)) continue
      server.env[key] = `${ENCRYPTED_VALUE_PREFIX}${encrypt(value)}`
    }
    return server
  })
}

export function decryptSensitiveMcpEnv(
  servers: McpServerEntry[] | undefined,
  decrypt: (value: string) => string
): McpServerEntry[] {
  return decryptSensitiveMcpEnvWithIssues(servers, decrypt).servers
}

export function decryptSensitiveMcpEnvWithIssues(
  servers: McpServerEntry[] | undefined,
  decrypt: (value: string) => string
): { servers: McpServerEntry[]; issues: McpSecretDecryptIssue[] } {
  if (!servers) return { servers: [], issues: [] }
  const issues: McpSecretDecryptIssue[] = []
  const decrypted = cloneMcpServers(servers).map((server) => {
    for (const [key, value] of Object.entries(server.env)) {
      if (!isSensitiveMcpEnvKey(key) || !encryptedValue(value)) continue
      try {
        server.env[key] = decrypt(value.slice(ENCRYPTED_VALUE_PREFIX.length))
      } catch (err: unknown) {
        server.env[key] = ''
        issues.push({
          serverId: server.id,
          serverName: server.name,
          key,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return server
  })
  return { servers: decrypted, issues }
}

export function hasEncryptedMcpEnv(servers: McpServerEntry[] | undefined): boolean {
  return Boolean(servers?.some((server) => (
    Object.entries(server.env).some(([key, value]) => isSensitiveMcpEnvKey(key) && encryptedValue(value))
  )))
}

export function maskSensitiveMcpEnvForView(servers: McpServerEntry[] | undefined): McpServerEntry[] {
  return cloneMcpServers(servers ?? []).map((server) => {
    for (const [key, value] of Object.entries(server.env)) {
      if (!isSensitiveMcpEnvKey(key) || !value) continue
      server.env[key] = maskSecret(value)
    }
    return server
  })
}

export function mergeMaskedMcpEnv(
  current: McpServerEntry[] | undefined,
  incoming: McpServerEntry[] | undefined
): McpServerEntry[] {
  if (!incoming) return []
  const currentById = new Map((current ?? []).map((server) => [server.id, server]))
  return cloneMcpServers(incoming).map((server) => {
    const existing = currentById.get(server.id)
    if (!existing) return server
    for (const [key, value] of Object.entries(server.env)) {
      if (!isSensitiveMcpEnvKey(key) || !isMaskedSecretValue(value)) continue
      const existingValue = existing.env[key]
      if (existingValue) server.env[key] = existingValue
    }
    return server
  })
}
