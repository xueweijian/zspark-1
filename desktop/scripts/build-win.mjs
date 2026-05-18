#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const useShell = process.platform === 'win32'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRoot = resolve(desktopDir, '..')
const codexRsDir = resolve(repoRoot, 'codex-rs')
const codexExe = resolve(repoRoot, 'codex-rs/target/release/codex.exe')
const winUnpackedDir = resolve(desktopDir, 'dist/win-unpacked')
const rendererAssetsDir = resolve(desktopDir, 'out/renderer/assets')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: useShell, ...options })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function ensureWindowsCodexExe() {
  if (process.platform === 'win32') {
    run('cargo', ['build', '--release', '-p', 'codex-cli'], { cwd: codexRsDir })
  }

  if (!existsSync(codexExe)) {
    console.error(`Missing Windows Codex binary: ${codexExe}`)
    console.error('Build codex-rs for Windows first so the packaged app can launch resources/bin/codex.exe.')
    process.exit(1)
  }
}

function verifyRendererSandboxBundle() {
  if (!existsSync(rendererAssetsDir)) {
    console.error(`Missing renderer assets after build: ${rendererAssetsDir}`)
    process.exit(1)
  }

  const jsFiles = readdirSync(rendererAssetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => resolve(rendererAssetsDir, name))
  const bundledJs = jsFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
  if (!bundledJs.includes('workspace-write') || !bundledJs.includes('workspaceWrite')) {
    console.error('Renderer bundle is missing the zspark workspace-write sandbox policy.')
    console.error('Refusing to package a Windows app that can start turns without sandbox metadata.')
    process.exit(1)
  }
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function stopWinUnpackedProcesses() {
  if (process.platform !== 'win32' || !existsSync(winUnpackedDir)) return

  const script = `
$ErrorActionPreference = 'Stop'
$separator = [System.IO.Path]::DirectorySeparatorChar
$target = [System.IO.Path]::GetFullPath(${psSingleQuote(winUnpackedDir)}).TrimEnd($separator) + $separator
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object {
    Write-Host "Stopping stale packaged app process $($_.ProcessId): $($_.ExecutablePath)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
  }
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'inherit', env, shell: false }
  )
  if (result.error) {
    console.warn(`Could not inspect stale Windows build processes: ${result.error.message}`)
  } else if (result.status !== 0) {
    console.warn('Could not stop every stale Windows build process; cleanup will retry and report any locked files.')
  }
}

async function removeWinUnpackedDir() {
  if (process.platform !== 'win32' || !existsSync(winUnpackedDir)) return

  stopWinUnpackedProcesses()
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(winUnpackedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
      return
    } catch (error) {
      lastError = error
      stopWinUnpackedProcesses()
      await sleep(500 * attempt)
    }
  }

  console.error(`Could not remove stale Windows output: ${winUnpackedDir}`)
  console.error('A previous packaged zspark process, Explorer preview, or antivirus scan is still locking a file there.')
  console.error('Close any zspark window launched from dist\\win-unpacked and retry the build.')
  throw lastError
}

ensureWindowsCodexExe()
await import(new URL('./build-gmail-mcp.mjs', import.meta.url))
run('electron-vite', ['build'])
verifyRendererSandboxBundle()
await removeWinUnpackedDir()
run('electron-builder', ['--win', 'nsis', ...process.argv.slice(2)])
