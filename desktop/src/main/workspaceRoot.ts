import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function discoverRepoRoot(start: string): string | null {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, '.git')) && (existsSync(join(dir, 'codex-rs')) || existsSync(join(dir, '.codex')))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function packagedWorkspaceRoot(): string {
  return join(app.getPath('documents'), 'zspark')
}

export function resolveWorkspaceRoot(start: string, explicitRoot = process.env.ZSPARK_WORKSPACE_ROOT): string {
  const explicit = explicitRoot?.trim()
  if (explicit) return resolve(explicit)

  const repoRoot = discoverRepoRoot(start)
  if (repoRoot) return repoRoot

  return app.isPackaged ? packagedWorkspaceRoot() : resolve(start)
}

export function ensureWorkspaceRoot(path: string): void {
  mkdirSync(path, { recursive: true })
}
