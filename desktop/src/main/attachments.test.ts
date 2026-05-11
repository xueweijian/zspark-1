import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  attachmentKindForMime,
  guessMimeType,
  importAttachmentFiles,
  sanitizeAttachmentName
} from './attachments'

const tempDirs: string[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'zspark-attachments-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('attachment imports', () => {
  test('sanitizes file names before copying them into the workspace', () => {
    expect(sanitizeAttachmentName('bad/name:deck?.pptx')).toBe('bad-name-deck-.pptx')
    expect(sanitizeAttachmentName('   ')).toBe('attachment')
  })

  test('classifies common image and office document files', () => {
    expect(guessMimeType('/tmp/screenshot.PNG')).toBe('image/png')
    expect(attachmentKindForMime(guessMimeType('/tmp/screenshot.PNG'))).toBe('image')
    expect(guessMimeType('/tmp/readout.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(attachmentKindForMime(guessMimeType('/tmp/readout.pptx'))).toBe('file')
  })

  test('copies attachments into a gitignored workspace folder', () => {
    const workspace = tempDir()
    const source = join(tempDir(), 'example doc.docx')
    writeFileSync(source, 'doc body')

    const result = importAttachmentFiles([source], workspace)

    expect(result.errors).toEqual([])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({
      name: 'example doc.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'file',
      size: 8
    })
    expect(existsSync(result.attachments[0].path)).toBe(true)
    expect(readFileSync(join(workspace, '.zspark-attachments', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
  })
})
