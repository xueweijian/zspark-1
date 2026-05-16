#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const useShell = process.platform === 'win32'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(scriptDir, '..')
const repoRoot = resolve(desktopDir, '..')
const codexExe = resolve(repoRoot, 'codex-rs/target/release/codex.exe')

if (!existsSync(codexExe)) {
  console.error(`Missing Windows Codex binary: ${codexExe}`)
  console.error('Build codex-rs for Windows first so the packaged app can launch resources/bin/codex.exe.')
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: useShell })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

await import(new URL('./build-gmail-mcp.mjs', import.meta.url))
run('electron-vite', ['build'])
run('electron-builder', ['--win', 'nsis', ...process.argv.slice(2)])
