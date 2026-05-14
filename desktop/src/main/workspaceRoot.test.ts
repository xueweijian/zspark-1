import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const mockElectron = vi.hoisted(() => ({
  documents: '',
  isPackaged: false
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockElectron.isPackaged
    },
    getPath: (name: string) => {
      if (name === 'documents') return mockElectron.documents
      throw new Error(`unexpected app path: ${name}`)
    }
  }
}))

import { resolveWorkspaceRoot } from './workspaceRoot'

const tempRoots: string[] = []

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'zspark-workspace-root-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  mockElectron.documents = ''
  mockElectron.isPackaged = false
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('resolveWorkspaceRoot', () => {
  test('discovers the repository root in development', () => {
    const repo = tempRoot()
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, 'codex-rs'))
    const nested = join(repo, 'desktop', 'out', 'main')
    mkdirSync(nested, { recursive: true })

    expect(resolveWorkspaceRoot(nested, '')).toBe(resolve(repo))
  })

  test('uses a writable user workspace for packaged installs outside a repo', () => {
    const installDir = tempRoot()
    const documents = tempRoot()
    mockElectron.documents = documents
    mockElectron.isPackaged = true

    expect(resolveWorkspaceRoot(installDir, '')).toBe(join(documents, 'zspark'))
  })

  test('honors an explicit workspace root override', () => {
    const explicit = join(tempRoot(), 'custom-workspace')

    expect(resolveWorkspaceRoot(tempRoot(), explicit)).toBe(resolve(explicit))
  })
})
