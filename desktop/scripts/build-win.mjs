#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
const bin = (name) => process.platform === 'win32' ? `${name}.cmd` : name
const codexExe = resolve('../codex-rs/target/release/codex.exe')

if (!existsSync(codexExe)) {
  console.error(`Missing Windows Codex binary: ${codexExe}`)
  console.error('Build codex-rs for Windows first so the packaged app can launch resources/bin/codex.exe.')
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(bin(command), args, { stdio: 'inherit', env })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('electron-vite', ['build'])
run('electron-builder', ['--win', 'nsis', ...process.argv.slice(2)])
