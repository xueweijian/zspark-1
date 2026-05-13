import { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, WriteStream, statSync, renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PublicClientApplication } from '@azure/msal-node'
import { scanRecentArtifacts } from './artifacts'
import { importAttachmentFiles } from './attachments'
import { startBridge, setUpstream } from './bridge'
import { discoverLocalSkills } from './localSkills'
import { redactSensitiveLogLine } from './logRedaction'

let mainWindow: BrowserWindow | null = null
let codex: ChildProcessWithoutNullStreams | null = null

interface ProviderConfig {
  baseUrl: string       // upstream endpoint (chat or responses)
  apiKey: string        // sk-...
  model: string         // e.g. gpt-4o-mini, gpt-5
  wireApi: 'responses' | 'chat'
}

interface EnterpriseConfig {
  serverUrl: string
  tenantId: string
  clientId: string
  apiScope: string
  authority: string
}

interface EnterpriseAuth {
  accessToken: string
  expiresAt: number
  username?: string
  name?: string
  homeAccountId?: string
}

interface AppSettings {
  provider?: ProviderConfig
  enterprise?: Partial<EnterpriseConfig>
  enterpriseAuth?: EnterpriseAuth
}

let bridgePort: number | null = null
let bridgeClose: (() => void) | null = null
let settingsLoadIssue: string | null = null

const PROVIDER_ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/models']
const DEFAULT_ENTRA_TENANT_ID = process.env.ZSPARK_TENANT_ID ?? 'ae266ff5-076f-4eb1-b91b-788a04d2abe0'
const DEFAULT_ENTRA_CLIENT_ID = process.env.ZSPARK_CLIENT_ID ?? '47a35772-7d8d-4308-9730-7f1b836dc40c'
const DEFAULT_ENTRA_API_SCOPE = process.env.ZSPARK_API_SCOPE ?? `api://${DEFAULT_ENTRA_CLIENT_ID}/access_as_user`
const DEFAULT_ENTRA_AUTHORITY = process.env.ZSPARK_AUTHORITY ?? `https://login.partner.microsoftonline.cn/${DEFAULT_ENTRA_TENANT_ID}`
const DEFAULT_WORKSPACE_SERVER_URL = process.env.ZSPARK_SERVER_URL ?? 'http://143.64.174.225:8787'

const SETTINGS_PATH = join(app.getPath('userData'), 'zspark-settings.json')
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.cwd())
const ATTACHMENTS_DIR = join(WORKSPACE_ROOT, '.zspark-attachments')
const CODEX_RUNTIME_DEPS_DIR = join(app.getPath('home'), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
const CODEX_RUNTIME_NODE = join(CODEX_RUNTIME_DEPS_DIR, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const CODEX_RUNTIME_NODE_MODULES = join(CODEX_RUNTIME_DEPS_DIR, 'node', 'node_modules')
const CODEX_RUNTIME_PYTHON = join(CODEX_RUNTIME_DEPS_DIR, 'python', 'bin', process.platform === 'win32' ? 'python.exe' : 'python3')
const MAX_CODEX_LOG_BYTES = 8 * 1024 * 1024
const BRIDGE_API_KEY = randomBytes(32).toString('hex')

function resolveWorkspaceRoot(start: string): string {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git')) && (existsSync(join(dir, 'codex-rs')) || existsSync(join(dir, '.codex')))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    settingsLoadIssue = null
    if (raw?.provider?.encryptedApiKey && settingsEncryptionAvailable()) {
      raw.provider.apiKey = safeStorage.decryptString(Buffer.from(raw.provider.encryptedApiKey, 'base64'))
      delete raw.provider.encryptedApiKey
    }
    if (raw?.enterpriseAuth?.encryptedAccessToken && settingsEncryptionAvailable()) {
      raw.enterpriseAuth.accessToken = safeStorage.decryptString(Buffer.from(raw.enterpriseAuth.encryptedAccessToken, 'base64'))
      delete raw.enterpriseAuth.encryptedAccessToken
    }
    return raw
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      settingsLoadIssue = null
      return {}
    }
    const backupPath = `${SETTINGS_PATH}.corrupt-${Date.now()}`
    try {
      if (existsSync(SETTINGS_PATH)) renameSync(SETTINGS_PATH, backupPath)
      settingsLoadIssue = `Settings could not be read and were preserved at ${backupPath}.`
    } catch (renameErr: any) {
      settingsLoadIssue = `Settings could not be read. ${renameErr?.message ?? String(renameErr)}`
    }
    return {}
  }
}

function settingsEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function settingsWarnings(s: AppSettings) {
  const warnings: string[] = []
  if (settingsLoadIssue) warnings.push(settingsLoadIssue)
  if (!settingsEncryptionAvailable()) {
    warnings.push('System keychain encryption is unavailable. Provider API keys and Entra tokens saved on this machine will be stored in the app settings file.')
  }
  if ((s.provider as any)?.encryptedApiKey && !s.provider?.apiKey) {
    warnings.push('An encrypted provider API key exists but cannot be decrypted on this machine. Re-enter the key before saving provider settings.')
  }
  if ((s.enterpriseAuth as any)?.encryptedAccessToken && !s.enterpriseAuth?.accessToken) {
    warnings.push('The saved Entra token cannot be decrypted on this machine. Sign in again before using shared workspaces.')
  }
  return warnings
}

function saveSettings(s: AppSettings) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const out: any = { ...s }
  if (out.provider?.apiKey && settingsEncryptionAvailable()) {
    out.provider = {
      ...out.provider,
      encryptedApiKey: safeStorage.encryptString(out.provider.apiKey).toString('base64')
    }
    delete out.provider.apiKey
  }
  if (out.enterpriseAuth?.accessToken && settingsEncryptionAvailable()) {
    out.enterpriseAuth = {
      ...out.enterpriseAuth,
      encryptedAccessToken: safeStorage.encryptString(out.enterpriseAuth.accessToken).toString('base64')
    }
    delete out.enterpriseAuth.accessToken
  }
  const tmpPath = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(out, null, 2), { mode: 0o600 })
  renameSync(tmpPath, SETTINGS_PATH)
  settingsLoadIssue = null
}

function defaultEnterpriseConfig(): EnterpriseConfig {
  return {
    serverUrl: DEFAULT_WORKSPACE_SERVER_URL,
    tenantId: DEFAULT_ENTRA_TENANT_ID,
    clientId: DEFAULT_ENTRA_CLIENT_ID,
    apiScope: DEFAULT_ENTRA_API_SCOPE,
    authority: DEFAULT_ENTRA_AUTHORITY
  }
}

function effectiveEnterpriseConfig(settings = loadSettings()): EnterpriseConfig {
  const defaults = defaultEnterpriseConfig()
  return {
    serverUrl: normalizeEnterpriseServerUrl(settings.enterprise?.serverUrl || defaults.serverUrl),
    tenantId: settings.enterprise?.tenantId || defaults.tenantId,
    clientId: settings.enterprise?.clientId || defaults.clientId,
    apiScope: settings.enterprise?.apiScope || defaults.apiScope,
    authority: (settings.enterprise?.authority || defaults.authority).replace(/\/+$/, '')
  }
}

function normalizeEnterpriseServerUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '')
}

function tokenIsUsable(auth?: EnterpriseAuth) {
  return Boolean(auth?.accessToken && auth.expiresAt > Date.now() + 60_000)
}

function safeSettingsView(s: AppSettings) {
  const view: AppSettings & { warnings: string[] } = {
    enterprise: effectiveEnterpriseConfig(s),
    warnings: settingsWarnings(s)
  }
  if (s.provider) {
    view.provider = {
      baseUrl: s.provider.baseUrl,
      model: s.provider.model,
      wireApi: s.provider.wireApi,
      apiKey: s.provider.apiKey ? s.provider.apiKey.slice(0, 4) + '••••' + s.provider.apiKey.slice(-4) : ''
    }
  }
  return view
}

function enterpriseStatus(settings = loadSettings()) {
  const auth = settings.enterpriseAuth
  return {
    configured: Boolean(effectiveEnterpriseConfig(settings).serverUrl && effectiveEnterpriseConfig(settings).clientId && effectiveEnterpriseConfig(settings).tenantId),
    signedIn: tokenIsUsable(auth),
    account: auth
      ? {
          username: auth.username,
          name: auth.name,
          homeAccountId: auth.homeAccountId,
          expiresAt: auth.expiresAt
        }
      : null,
    config: effectiveEnterpriseConfig(settings)
  }
}

async function enterpriseRequest(path: string, init: RequestInit = {}) {
  const fetched = await enterpriseFetchResponse(path, init)
  if (!fetched.response) return fetched
  const response = fetched.response
  const bodyText = await response.text()
  let body: any = null
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    body = { text: bodyText }
  }
  if (!response.ok) {
    const error = [body?.error, body?.detail].filter(Boolean).join(': ')
    return { ok: false, status: response.status, error: error || bodyText }
  }
  return { ok: true, status: response.status, ...body }
}

async function enterpriseFetchResponse(path: string, init: RequestInit = {}) {
  const settings = loadSettings()
  const auth = settings.enterpriseAuth
  if (!tokenIsUsable(auth)) {
    return { ok: false, status: 401, error: 'Sign in to shared workspaces first.' }
  }
  const config = effectiveEnterpriseConfig(settings)
  const response = await fetch(`${config.serverUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      authorization: `Bearer ${auth!.accessToken}`
    }
  })
  return { response }
}

function artifactMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.ppt': return 'application/vnd.ms-powerpoint'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.doc': return 'application/msword'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xls': return 'application/vnd.ms-excel'
    case '.csv': return 'text/csv'
    case '.pdf': return 'application/pdf'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

function contentDispositionFileName(header: string | null) {
  if (!header) return null
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1]) } catch {}
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? /filename=([^;]+)/i.exec(header)?.[1]?.trim() ?? null
}

function isInsidePath(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function allowedLocalPathRoots() {
  return [
    WORKSPACE_ROOT,
    app.getPath('downloads')
  ]
}

function resolveAllowedLocalPath(filePath: string) {
  const normalized = isAbsolute(filePath) ? resolve(filePath) : resolve(WORKSPACE_ROOT, filePath)
  if (!allowedLocalPathRoots().some((root) => isInsidePath(root, normalized))) {
    throw new Error('Path is outside the allowed zspark workspace/download directories')
  }
  return normalized
}

async function openExternalUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
    throw new Error('Unsupported link protocol')
  }
  await shell.openExternal(url.toString())
}

function resolveCodexBinary(): string {
  const dev = join(__dirname, '..', '..', '..', 'codex-rs', 'target', 'release',
    process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

function normalizeProviderBaseUrl(rawBaseUrl: string): string {
  try {
    const url = new URL(rawBaseUrl.trim())
    let path = url.pathname.replace(/\/+$/, '')
    for (const suffix of PROVIDER_ENDPOINT_SUFFIXES) {
      if (path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length).replace(/\/+$/, '')
        break
      }
    }
    url.pathname = path || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return rawBaseUrl.trim().replace(/\/+$/, '')
  }
}

function workspaceRuntimeInfo() {
  const available = existsSync(CODEX_RUNTIME_NODE) && existsSync(CODEX_RUNTIME_NODE_MODULES) && existsSync(CODEX_RUNTIME_PYTHON)
  return {
    nodePath: CODEX_RUNTIME_NODE,
    nodeModulesPath: CODEX_RUNTIME_NODE_MODULES,
    pythonPath: CODEX_RUNTIME_PYTHON,
    available
  }
}

function workspaceRuntimeEnv(): Record<string, string> {
  const rt = workspaceRuntimeInfo()
  if (!rt.available) return {}
  return {
    ZSPARK_CODEX_RUNTIME_NODE: rt.nodePath,
    ZSPARK_CODEX_RUNTIME_NODE_MODULES: rt.nodeModulesPath,
    ZSPARK_CODEX_RUNTIME_PYTHON: rt.pythonPath,
    NODE_PATH: [rt.nodeModulesPath, process.env.NODE_PATH].filter(Boolean).join(delimiter),
    PATH: `${dirname(rt.nodePath)}${delimiter}${process.env.PATH ?? ''}`
  }
}

function rotateLogIfLarge(path: string) {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_CODEX_LOG_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    // Diagnostics must never prevent the app-server from starting.
  }
}

function formatCodexLogChunk(channel: 'stdout' | 'stderr', chunk: string): string {
  return chunk.split(/\n/).map((line, index, lines) => {
    if (!line && index === lines.length - 1) return ''
    const trimmed = line.trim()
    if (trimmed) {
      try {
        const json = JSON.parse(trimmed)
        if (json?.method === 'item/agentMessage/delta') {
          const params = json.params ?? {}
          return `[${channel}] ${JSON.stringify({
            method: json.method,
            threadId: params.threadId,
            turnId: params.turnId,
            itemId: params.itemId,
            deltaChars: String(params.delta ?? '').length
          })}\n`
        }
      } catch {}
    }
    return `[${channel}] ${redactSensitiveLogLine(line)}\n`
  }).join('')
}

/**
 * Build `-c key=value` overrides that point codex at the user-configured
 * OpenAI-compatible endpoint, without touching ~/.codex/config.toml.
 *
 *   model_provider = "zspark"
 *   model = "<user model>"
 *   model_providers.zspark.name = "zspark"
 *   model_providers.zspark.base_url = "<user url>"
 *   model_providers.zspark.wire_api = "responses"
 *   model_providers.zspark.env_key = "ZSPARK_API_KEY"
 *
 * The api key itself is passed via env var, never on argv.
 * Chat-completions providers are exposed to codex through the local
 * Chat→Responses bridge, so codex still talks Responses on its side.
 *
 * We also disable the bundled computer-use / playwright MCP servers and
 * trust the zspark workspace so the chat doesn't get spammed by config
 * warnings or MCP startup failures (those bundled MCPs need optional
 * platform binaries that aren't relevant inside zspark). zspark opts into
 * Codex's native memory feature so persisted memory generation/use works
 * even though the upstream feature flag is experimental and off by default.
 */
function buildProviderArgs(p?: ProviderConfig): { args: string[]; env: Record<string, string> } {
  const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const baseArgs = [
    // Trust our own workspace so codex stops nagging about project-local
    // config every spawn. The path is whatever directory the binary
    // happens to look at; trust the parent so any subfolder counts.
    '-c', `projects.${tomlString(WORKSPACE_ROOT)}.trust_level=${tomlString('trusted')}`,
    // Drop the bundled MCP servers — zspark ships its own skills.
    '-c', `mcp_servers={}`,
    // Keep Codex native memories available in zspark. This only enables the
    // feature gate; [memories] use/generate settings still come from config.
    '-c', `features.memories=true`
  ]
  if (!p?.baseUrl || !p?.apiKey || !p?.model) return { args: baseArgs, env: {} }

  // Decide whether to point codex at the upstream directly (Responses
  // API) or at our in-process Chat→Responses bridge.
  let effectiveBase = normalizeProviderBaseUrl(p.baseUrl)
  let effectiveKey = p.apiKey
  if (p.wireApi === 'chat') {
    setUpstream({ baseUrl: p.baseUrl, apiKey: p.apiKey })
    effectiveBase = `http://127.0.0.1:${bridgePort ?? 0}/v1`
    effectiveKey = BRIDGE_API_KEY
  } else {
    setUpstream(null)
  }

  const args = [
    ...baseArgs,
    '-c', `model=${tomlString(p.model)}`,
    '-c', `model_provider=${tomlString('zspark')}`,
    '-c', `model_providers.zspark.name=${tomlString('zspark')}`,
    '-c', `model_providers.zspark.base_url=${tomlString(effectiveBase)}`,
    '-c', `model_providers.zspark.wire_api=${tomlString('responses')}`,
    '-c', `model_providers.zspark.env_key=${tomlString('ZSPARK_API_KEY')}`,
    '-c', `model_providers.zspark.requires_openai_auth=false`
  ]
  return { args, env: { ZSPARK_API_KEY: effectiveKey } }
}

function spawnCodex() {
  const bin = resolveCodexBinary()
  const settings = loadSettings()
  const { args: providerArgs, env: providerEnv } = buildProviderArgs(settings.provider)
  // Pipe a verbose, structured trace of the codex stdout/stderr stream to a
  // user-data log file so we can diagnose model wire-protocol issues without
  // turning on full RUST_LOG noise in the chat UI.
  const logPath = join(app.getPath('userData'), 'codex-stream.log')
  mkdirSync(app.getPath('userData'), { recursive: true })
  rotateLogIfLarge(logPath)
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'a' })
  logStream.write(`\n=== ${new Date().toISOString()} spawn args=${JSON.stringify(providerArgs)} ===\n`)
  const child = spawn(bin, [...providerArgs, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, ...workspaceRuntimeEnv(), ...providerEnv, RUST_LOG: process.env.RUST_LOG ?? 'warn,codex_app_server=info' }
  })
  codex = child
  child.stdout.on('data', (b) => {
    if (codex !== child) return
    const s = b.toString()
    logStream.write(formatCodexLogChunk('stdout', s))
    mainWindow?.webContents.send('codex:stdout', s)
  })
  child.stderr.on('data', (b) => {
    if (codex !== child) return
    const s = b.toString()
    logStream.write(formatCodexLogChunk('stderr', s))
    mainWindow?.webContents.send('codex:stderr', s)
  })
  child.on('exit', (code) => {
    logStream.write(`[exit] ${code}\n`)
    logStream.end()
    if (codex === child) {
      codex = null
      mainWindow?.webContents.send('codex:exit', code)
    }
  })
  mainWindow?.webContents.send('codex:spawned')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'zspark',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (!currentUrl || url === currentUrl) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      openExternalUrl(url).catch(() => {})
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

ipcMain.handle('codex:send', (_e, line: string) => {
  if (!codex || codex.killed || !codex.stdin.writable) return false
  codex.stdin.write(line.endsWith('\n') ? line : line + '\n')
  return true
})

ipcMain.handle('codex:restart', () => {
  codex?.kill()
  spawnCodex()
  return true
})

ipcMain.handle('settings:get', () => {
  const s = loadSettings()
  // Return a redacted view to the renderer.
  return safeSettingsView(s)
})

ipcMain.handle('settings:save', (_e, partial: AppSettings) => {
  // If the renderer sends back the masked key, keep the existing one.
  const cur = loadSettings()
  const next: AppSettings = { ...cur, ...partial }
  if (next.provider) {
    if (next.provider.apiKey?.includes('••••') && cur.provider?.apiKey) {
      next.provider.apiKey = cur.provider.apiKey
    }
  }
  if (next.enterprise) {
    next.enterprise = {
      ...effectiveEnterpriseConfig(cur),
      ...next.enterprise
    }
  }
  saveSettings(next)
  if (partial.provider) {
    // Restart codex with new provider so the change takes effect immediately.
    codex?.kill()
    spawnCodex()
  }
  return { ok: true, warnings: settingsWarnings(next) }
})

ipcMain.handle('enterprise:status', () => enterpriseStatus())

ipcMain.handle('enterprise:logout', () => {
  const settings = loadSettings()
  delete settings.enterpriseAuth
  saveSettings(settings)
  return enterpriseStatus(settings)
})

ipcMain.handle('enterprise:login', async () => {
  try {
    const settings = loadSettings()
    const config = effectiveEnterpriseConfig(settings)
    settings.enterprise = config
    saveSettings(settings)

    const app = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: config.authority,
        knownAuthorities: ['login.partner.microsoftonline.cn']
      }
    })
    const result = await app.acquireTokenByDeviceCode({
      scopes: [config.apiScope],
      deviceCodeCallback: (response: any) => {
        mainWindow?.webContents.send('enterprise:deviceCode', {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          expiresOn: response.expiresOn?.getTime?.() ?? null,
          message: response.message
        })
        if (response.verificationUri) {
          openExternalUrl(response.verificationUri).catch(() => {})
        }
      }
    })
    if (!result?.accessToken) {
      return { ok: false, error: 'Entra login did not return an access token.' }
    }

    const next = loadSettings()
    next.enterprise = config
    next.enterpriseAuth = {
      accessToken: result.accessToken,
      expiresAt: result.expiresOn?.getTime() ?? Date.now() + 3_600_000,
      username: result.account?.username,
      name: result.account?.name,
      homeAccountId: result.account?.homeAccountId
    }
    saveSettings(next)
    return { ok: true, status: enterpriseStatus(next) }
  } catch (err: any) {
    return {
      ok: false,
      error: formatEnterpriseLoginError(err),
      code: err?.errorCode ?? err?.code ?? null
    }
  }
})

function formatEnterpriseLoginError(err: any) {
  const raw = [err?.errorMessage, err?.message, err?.subError].filter(Boolean).join(' ')
  if (/invalid_client|AADSTS7000218/i.test(raw)) {
    return 'Entra rejected zspark as a public desktop client. In Azure Portal, open zspark-desktop -> Authentication -> Advanced settings -> Allow public client flows -> Yes, then try signing in again.'
  }
  return raw || String(err)
}

ipcMain.handle('enterprise:whoami', () => enterpriseRequest('/auth/whoami'))

ipcMain.handle('enterprise:workspaces', () => enterpriseRequest('/workspaces'))

ipcMain.handle('enterprise:createWorkspace', (_e, name?: string) => (
  enterpriseRequest('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name })
  })
))

ipcMain.handle('enterprise:sessions', (_e, workspaceId: string) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`)
))

ipcMain.handle('enterprise:createSession', (_e, workspaceId: string, body: any = {}) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
))

ipcMain.handle('enterprise:readSession', (_e, workspaceId: string, sessionId: string) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`)
))

ipcMain.handle('enterprise:updateSession', (_e, workspaceId: string, sessionId: string, body: any = {}) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
))

ipcMain.handle('enterprise:deleteSession', (_e, workspaceId: string, sessionId: string) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  })
))

ipcMain.handle('enterprise:artifacts', (_e, workspaceId: string, sessionId: string) => (
  enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts`)
))

ipcMain.handle('enterprise:uploadArtifact', (_e, workspaceId: string, sessionId: string, filePath: string, meta: any = {}) => {
  try {
    if (!filePath) return { ok: false, error: 'Missing file path' }
    const safePath = resolveAllowedLocalPath(filePath)
    if (!existsSync(safePath)) return { ok: false, error: 'File does not exist' }
    const stat = statSync(safePath)
    if (!stat.isFile()) return { ok: false, error: 'Path is not a file' }
    const content = readFileSync(safePath)
    return enterpriseRequest(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        name: meta.name || basename(safePath),
        mimeType: meta.mimeType || artifactMimeType(safePath),
        localPath: safePath,
        turnId: meta.turnId,
        contentBase64: content.toString('base64')
      })
    })
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('enterprise:downloadArtifact', async (_e, workspaceId: string, sessionId: string, artifactId: string, name?: string) => {
  try {
    const fetched = await enterpriseFetchResponse(
      `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/download`
    )
    if (!fetched.response) return fetched
    const response = fetched.response
    if (!response.ok) {
      const text = await response.text()
      return { ok: false, status: response.status, error: text || `Download failed with HTTP ${response.status}` }
    }
    const defaultName = name || contentDispositionFileName(response.headers.get('content-disposition')) || artifactId
    const save = mainWindow
      ? await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath('downloads'), basename(defaultName)) })
      : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), basename(defaultName)) })
    if (save.canceled || !save.filePath) return { ok: false, canceled: true }
    if (!response.body) return { ok: false, error: 'Download response did not include a body' }
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(save.filePath))
    return { ok: true, path: save.filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('attachments:pick', async () => {
  const options: OpenDialogOptions = {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'pdf', 'txt', 'md', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) {
    return { attachments: [], errors: [] }
  }
  return importAttachmentFiles(picked.filePaths, WORKSPACE_ROOT)
})

ipcMain.handle('runtime:get', () => {
  const settings = loadSettings()
  return {
    workspaceRoot: WORKSPACE_ROOT,
    attachmentDir: ATTACHMENTS_DIR,
    codexRunning: Boolean(codex && !codex.killed),
    bridgePort,
    provider: settings.provider
      ? {
          baseUrl: normalizeProviderBaseUrl(settings.provider.baseUrl),
          model: settings.provider.model,
          wireApi: settings.provider.wireApi
        }
      : undefined,
    workspaceRuntime: workspaceRuntimeInfo()
  }
})

ipcMain.handle('skills:localAvailability', () => discoverLocalSkills(WORKSPACE_ROOT))

ipcMain.handle('path:open', async (_e, filePath: string) => {
  try {
    if (!filePath) return { ok: false, error: 'Missing file path' }
    const safePath = resolveAllowedLocalPath(filePath)
    const error = await shell.openPath(safePath)
    return error ? { ok: false, error } : { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('path:reveal', (_e, filePath: string) => {
  try {
    if (!filePath) return { ok: false, error: 'Missing file path' }
    shell.showItemInFolder(resolveAllowedLocalPath(filePath))
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('path:download', async (_e, filePath: string) => {
  let safePath: string
  try {
    if (!filePath) return { ok: false, error: 'Missing file path' }
    safePath = resolveAllowedLocalPath(filePath)
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
  if (!existsSync(safePath)) return { ok: false, error: 'File does not exist' }
  const save = mainWindow
    ? await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath('downloads'), basename(safePath)) })
    : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), basename(safePath)) })
  if (save.canceled || !save.filePath) return { ok: false, canceled: true }
  try {
    copyFileSync(safePath, save.filePath)
    return { ok: true, path: save.filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('path:stat', (_e, filePath: string) => {
  if (!filePath) return { exists: false, error: 'Missing file path' }
  try {
    const safePath = resolveAllowedLocalPath(filePath)
    const stat = statSync(safePath)
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  } catch {
    return { exists: false, error: 'File is unavailable or outside the allowed zspark directories' }
  }
})

ipcMain.handle('url:openExternal', async (_e, rawUrl: string) => {
  try {
    await openExternalUrl(rawUrl)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('artifacts:scanRecent', (_e, options: { sinceMs?: number; limit?: number } = {}) => ({
  root: join(WORKSPACE_ROOT, 'outputs'),
  artifacts: scanRecentArtifacts(WORKSPACE_ROOT, {
    sinceMs: options.sinceMs,
    limit: options.limit
  })
}))

app.whenReady().then(async () => {
  const b = await startBridge(BRIDGE_API_KEY)
  bridgePort = b.port
  bridgeClose = b.close
  spawnCodex()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  codex?.kill()
  bridgeClose?.()
  if (process.platform !== 'darwin') app.quit()
})
