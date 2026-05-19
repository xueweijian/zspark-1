/**
 * Persistence + codex-args merge for user-configured MCP servers.
 *
 * Stored as part of zspark-settings.json under `mcpServers`. Each entry is a
 * fully describable launch (command + args + env + enabled flag + a stable
 * id) so the renderer can CRUD without the main process having to mutate
 * existing records in place.
 */

export interface McpServerEntry {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

export interface McpServersLaunchConfig {
  toml: string
  env: Record<string, string>
}

const TOML_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function tomlKey(name: string): string {
  // codex-rs expects mcp_servers.<key> where <key> is a bare TOML key.
  // Quote anything that doesn't fit the bare-key grammar so we never emit
  // invalid TOML.
  return TOML_KEY_RE.test(name) ? name : tomlString(name)
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

export function sanitizeMcpServer(raw: unknown): McpServerEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : null
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const command = typeof r.command === 'string' ? r.command.trim() : ''
  if (!id || !name || !command) return null

  const rawArgs = Array.isArray(r.args) ? r.args : []
  const args = rawArgs.filter((v): v is string => typeof v === 'string')

  const envRaw = r.env && typeof r.env === 'object' ? (r.env as Record<string, unknown>) : {}
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof k !== 'string' || !k) continue
    if (typeof v !== 'string') continue
    env[k] = v
  }

  return {
    id,
    name,
    command,
    args,
    env,
    enabled: r.enabled !== false
  }
}

export function sanitizeMcpServerList(raw: unknown): McpServerEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: McpServerEntry[] = []
  for (const item of raw) {
    const entry = sanitizeMcpServer(item)
    if (!entry) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

export function duplicateMcpServerNames(entries: McpServerEntry[]): string[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.enabled) continue
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  }
  const duplicates: string[] = []
  for (const [name, count] of counts) {
    if (count > 1) duplicates.push(name)
  }
  return duplicates
}

/**
 * Build the MCP launch config passed to codex-rs.
 *
 * Secret values must not be embedded in `-c mcp_servers=...` because argv is
 * visible via process listings. Instead, pass only `env_vars` names in the
 * TOML and provide the actual values in the app-server process environment.
 */
export function buildMcpServersLaunchConfig(entries: McpServerEntry[]): McpServersLaunchConfig {
  const active: McpServerEntry[] = []
  const seenNames = new Set<string>()
  for (const entry of entries) {
    if (!entry.enabled) continue
    if (seenNames.has(entry.name)) continue
    seenNames.add(entry.name)
    active.push(entry)
  }
  if (active.length === 0) return { toml: '{}', env: {} }

  const env: Record<string, string> = {}
  const body = active
    .map((entry) => {
      const envNames = Object.keys(entry.env).filter(Boolean)
      for (const name of envNames) {
        if (env[name] === undefined) env[name] = entry.env[name]
      }
      const fields = [
        `command = ${tomlString(entry.command)}`,
        `args = ${tomlArray(entry.args)}`,
        ...(envNames.length ? [`env_vars = ${tomlArray(envNames)}`] : [])
      ]
      return `${tomlKey(entry.name)} = { ${fields.join(', ')} }`
    })
    .join(', ')
  return { toml: `{ ${body} }`, env }
}

/**
 * Build the TOML fragment passed to codex-rs via `-c mcp_servers=...`.
 * codex-rs accepts a single inline-table value: each key is the server
 * name (used in routing), and each value is an inline table with
 * `command`, `args`, and `env_vars` fields.
 *
 * If no entries are enabled we emit an empty inline table so codex-rs
 * still parses cleanly (this is the same value the previous implementation
 * passed unconditionally).
 */
export function buildMcpServersTomlValue(entries: McpServerEntry[]): string {
  return buildMcpServersLaunchConfig(entries).toml
}

/**
 * Generate a stable-enough id for a freshly-created entry. Not cryptographic;
 * just needs to avoid collisions inside one settings file.
 */
export function generateMcpServerId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
