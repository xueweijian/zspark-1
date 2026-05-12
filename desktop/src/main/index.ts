import { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename, delimiter, dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, WriteStream, statSync, renameSync } from 'node:fs'
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

let bridgePort: number | null = null
let bridgeClose: (() => void) | null = null

const PROVIDER_ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/models']

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

function loadSettings(): { provider?: ProviderConfig } {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    if (raw?.provider?.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
      raw.provider.apiKey = safeStorage.decryptString(Buffer.from(raw.provider.encryptedApiKey, 'base64'))
      delete raw.provider.encryptedApiKey
    }
    return raw
  } catch {
    return {}
  }
}

function saveSettings(s: { provider?: ProviderConfig }) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const out: any = { ...s }
  if (out.provider?.apiKey && safeStorage.isEncryptionAvailable()) {
    out.provider = {
      ...out.provider,
      encryptedApiKey: safeStorage.encryptString(out.provider.apiKey).toString('base64')
    }
    delete out.provider.apiKey
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(out, null, 2))
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
  const tomlString = (s: string) => `"${s.replace(/"/g, '\\"')}"`
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
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (!currentUrl || url === currentUrl) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url)
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
  // Return a redacted view to the renderer (mask the api key).
  if (s.provider?.apiKey) {
    return { ...s, provider: { ...s.provider, apiKey: s.provider.apiKey.slice(0, 4) + '••••' + s.provider.apiKey.slice(-4) } }
  }
  return s
})

ipcMain.handle('settings:save', (_e, partial: { provider?: ProviderConfig }) => {
  // If the renderer sends back the masked key, keep the existing one.
  const cur = loadSettings()
  const next: { provider?: ProviderConfig } = { ...cur, ...partial }
  if (next.provider) {
    if (next.provider.apiKey?.includes('••••') && cur.provider?.apiKey) {
      next.provider.apiKey = cur.provider.apiKey
    }
  }
  saveSettings(next)
  // Restart codex with new provider so the change takes effect immediately.
  codex?.kill()
  spawnCodex()
  return true
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
  if (!filePath) return { ok: false, error: 'Missing file path' }
  const error = await shell.openPath(filePath)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('path:reveal', (_e, filePath: string) => {
  if (!filePath) return { ok: false, error: 'Missing file path' }
  shell.showItemInFolder(filePath)
  return { ok: true }
})

ipcMain.handle('path:download', async (_e, filePath: string) => {
  if (!filePath) return { ok: false, error: 'Missing file path' }
  if (!existsSync(filePath)) return { ok: false, error: 'File does not exist' }
  const save = mainWindow
    ? await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath('downloads'), basename(filePath)) })
    : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), basename(filePath)) })
  if (save.canceled || !save.filePath) return { ok: false, canceled: true }
  try {
    copyFileSync(filePath, save.filePath)
    return { ok: true, path: save.filePath }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
})

ipcMain.handle('path:stat', (_e, filePath: string) => {
  if (!filePath) return { exists: false, error: 'Missing file path' }
  try {
    const stat = statSync(filePath)
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  } catch {
    return { exists: false }
  }
})

ipcMain.handle('url:openExternal', async (_e, rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return { ok: false, error: 'Unsupported link protocol' }
    }
    await shell.openExternal(url.toString())
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
