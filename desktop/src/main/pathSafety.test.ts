import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const mockElectron = vi.hoisted(() => ({
  downloads: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => mockElectron.downloads
  },
  shell: {
    openExternal: vi.fn()
  }
}))

import { resolveAllowedLocalPath } from './pathSafety'

const tempRoots: string[] = []

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'zspark-path-safety-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('resolveAllowedLocalPath', () => {
  test('returns the real path for files inside the workspace', () => {
    const workspace = tempRoot()
    mockElectron.downloads = tempRoot()
    const file = join(workspace, 'ok.txt')
    writeFileSync(file, 'ok')

    expect(resolveAllowedLocalPath(workspace, 'ok.txt')).toBe(realpathSync(file))
  })

  test.skipIf(process.platform === 'win32')('rejects symlinks that resolve outside allowed roots', () => {
    const workspace = tempRoot()
    mockElectron.downloads = tempRoot()
    const outside = join(tempRoot(), 'secret.txt')
    writeFileSync(outside, 'secret')
    const link = join(workspace, 'linked-secret.txt')
    symlinkSync(outside, link)

    expect(() => resolveAllowedLocalPath(workspace, link)).toThrow(/resolves outside/)
  })

  test('allows future paths under workspace whose file does not yet exist', () => {
    const workspace = tempRoot()
    mockElectron.downloads = tempRoot()
    const future = join(workspace, 'output', 'deep', 'not-yet.pptx')
    // realpath of the workspace directory should still anchor the result.
    const resolved = resolveAllowedLocalPath(workspace, future)
    expect(resolved.startsWith(realpathSync(workspace))).toBe(true)
    expect(resolved.endsWith(join('output', 'deep', 'not-yet.pptx'))).toBe(true)
  })

  test('rejects future paths whose existing ancestor is outside allowed roots', () => {
    const workspace = tempRoot()
    mockElectron.downloads = tempRoot()
    const escape = join(tempRoot(), 'elsewhere', 'unborn.txt')
    expect(() => resolveAllowedLocalPath(workspace, escape)).toThrow(/resolves outside/)
  })
})
