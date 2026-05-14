import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scanRecentArtifacts } from './artifacts'

const tempDirs: string[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'zspark-artifacts-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('artifact scanning', () => {
  test('finds recent deliverables under outputs', () => {
    const workspace = tempDir()
    const outputDir = join(workspace, 'outputs', 'turn-1', 'presentations', 'demo', 'output')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'board-readout.pptx'), 'pptx')

    expect(scanRecentArtifacts(workspace, { sinceMs: 0 })).toEqual([
      expect.objectContaining({
        name: 'board-readout.pptx',
        path: join(outputDir, 'board-readout.pptx'),
        size: 4
      })
    ])
  })

  test('skips scratch previews and older files', () => {
    const workspace = tempDir()
    const previewDir = join(workspace, 'outputs', 'turn-1', 'presentations', 'demo', 'preview')
    const outputDir = join(workspace, 'outputs', 'turn-1', 'presentations', 'demo', 'output')
    mkdirSync(previewDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(previewDir, 'slide-01.png'), 'preview')
    const oldDeck = join(outputDir, 'deck.pptx')
    writeFileSync(oldDeck, 'pptx')
    const oldDate = new Date(Date.now() - 60_000)
    utimesSync(oldDeck, oldDate, oldDate)

    const afterOldDeck = Date.now() - 1000

    expect(scanRecentArtifacts(workspace, { sinceMs: afterOldDeck })).toEqual([])
  })

  test('can return only the newest deliverable for chat fallback cards', () => {
    const workspace = tempDir()
    const outputDir = join(workspace, 'outputs', 'turn-1', 'documents', 'demo', 'output')
    mkdirSync(outputDir, { recursive: true })
    const olderDoc = join(outputDir, 'draft.docx')
    const finalDoc = join(outputDir, 'final.docx')
    writeFileSync(olderDoc, 'draft')
    writeFileSync(finalDoc, 'final')
    const oldDate = new Date(Date.now() - 60_000)
    utimesSync(olderDoc, oldDate, oldDate)

    expect(scanRecentArtifacts(workspace, { sinceMs: 0, limit: 1 })).toEqual([
      expect.objectContaining({
        name: 'final.docx',
        path: finalDoc,
        size: 5
      })
    ])
  })
})
