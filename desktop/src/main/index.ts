import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

let mainWindow: BrowserWindow | null = null
let codex: ChildProcessWithoutNullStreams | null = null

function resolveCodexBinary(): string {
  const dev = join(__dirname, '..', '..', '..', 'codex-rs', 'target', 'release', process.platform === 'win32' ? 'codex.exe' : 'codex')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

function spawnCodex() {
  const bin = resolveCodexBinary()
  codex = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
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
