import { describe, expect, test } from 'vitest'
import { clearDisplayedArtifactRevisions, rememberDisplayedArtifactRevisions, shouldDisplayScannedArtifact } from './artifactDisplay'
import type { WorkspaceFile } from './appTypes'

function file(path: string, name: string, updatedAt: number): WorkspaceFile {
  return {
    id: path,
    path,
    name,
    source: 'change',
    status: 'created',
    updatedAt
  }
}

describe('artifact display revision tracking', () => {
  test('suppresses an already-shown artifact revision by path and mtime', () => {
    const shown = new Map<string, number>()
    rememberDisplayedArtifactRevisions([file('/tmp/output.pptx', 'output.pptx', 1000)], shown)

    expect(shouldDisplayScannedArtifact({ path: '/tmp/output.pptx', mtimeMs: 1000 }, shown)).toBe(false)
    expect(shouldDisplayScannedArtifact({ path: '/tmp/output.pptx', mtimeMs: 999 }, shown)).toBe(false)
  })

  test('allows a newer artifact revision even when basename is unchanged', () => {
    const shown = new Map<string, number>()
    rememberDisplayedArtifactRevisions([file('/tmp/output.pptx', 'output.pptx', 1000)], shown)

    expect(shouldDisplayScannedArtifact({ path: '/tmp/output.pptx', mtimeMs: 1500 }, shown)).toBe(true)
    expect(shouldDisplayScannedArtifact({ path: '/tmp/final/output.pptx', mtimeMs: 1000 }, shown)).toBe(true)
  })

  test('does not remember missing artifacts as displayed', () => {
    const shown = new Map<string, number>()
    rememberDisplayedArtifactRevisions([{ ...file('/tmp/missing.pptx', 'missing.pptx', 1000), status: 'missing' }], shown)
    expect(shouldDisplayScannedArtifact({ path: '/tmp/missing.pptx', mtimeMs: 1000 }, shown)).toBe(true)
  })

  test('clears remembered revisions on thread reset', () => {
    const shown = new Map<string, number>()
    rememberDisplayedArtifactRevisions([file('/tmp/output.pptx', 'output.pptx', 1000)], shown)
    clearDisplayedArtifactRevisions(shown)
    expect(shouldDisplayScannedArtifact({ path: '/tmp/output.pptx', mtimeMs: 1000 }, shown)).toBe(true)
  })
})
