import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

let mainWindow: BrowserWindow | null = null
let codex: ChildProcessWithoutNullStreams | null = null

interface ProviderConfig {
  baseUrl: string       // e.g. https://api.openai.com/v1
  apiKey: string        // sk-...
  model: string         // e.g. gpt-4o-mini, gpt-5
  wireApi: 'responses' | 'chat'
}

const SETTINGS_PATH = join(app.getPath('userData'), 'zspark-settings.json')

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

/**
 * Build `-c key=value` overrides that point codex at the user-configured
 * OpenAI-compatible endpoint, without touching ~/.codex/config.toml.
 *
 *   model_provider = "zspark"
 *   model = "<user model>"
 *   model_providers.zspark.name = "zspark"
 *   model_providers.zspark.base_url = "<user url>"
 *   model_providers.zspark.wire_api = "responses" | "chat"
 *   model_providers.zspark.env_key = "ZSPARK_API_KEY"
 *
 * The api key itself is passed via env var, never on argv.
 */
function buildProviderArgs(p?: ProviderConfig): { args: string[]; env: Record<string, string> } {
  if (!p?.baseUrl || !p?.apiKey || !p?.model) return { args: [], env: {} }
  const tomlString = (s: string) => `"${s.replace(/"/g, '\\"')}"`
  const args = [
    '-c', `model=${tomlString(p.model)}`,
    '-c', `model_provider=${tomlString('zspark')}`,
    '-c', `model_providers.zspark.name=${tomlString('zspark')}`,
    '-c', `model_providers.zspark.base_url=${tomlString(p.baseUrl)}`,
    '-c', `model_providers.zspark.wire_api=${tomlString(p.wireApi)}`,
    '-c', `model_providers.zspark.env_key=${tomlString('ZSPARK_API_KEY')}`,
    '-c', `model_providers.zspark.requires_openai_auth=false`
  ]
  return { args, env: { ZSPARK_API_KEY: p.apiKey } }
}

function spawnCodex() {
  const bin = resolveCodexBinary()
  const settings = loadSettings()
  const { args: providerArgs, env: providerEnv } = buildProviderArgs(settings.provider)
  codex = spawn(bin, [...providerArgs, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...providerEnv }
  })
  codex.stdout.on('data', (b) => mainWindow?.webContents.send('codex:stdout', b.toString()))
  codex.stderr.on('data', (b) => mainWindow?.webContents.send('codex:stderr', b.toString()))
  codex.on('exit', (code) => mainWindow?.webContents.send('codex:exit', code))
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
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

ipcMain.handle('codex:send', (_e, line: string) => {
  if (!codex) return false
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

app.whenReady().then(() => {
  spawnCodex()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  codex?.kill()
  if (process.platform !== 'darwin') app.quit()
})
