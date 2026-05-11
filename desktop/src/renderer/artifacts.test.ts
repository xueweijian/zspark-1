import { describe, expect, test } from 'vitest'
import { dirname, extractArtifactPathCandidates, resolveWorkspacePath } from './artifacts'

describe('artifact helpers', () => {
  test('extracts workspace artifact paths from assistant text', () => {
    const text = [
      'Final file: `outputs/manual/presentations/demo/output/Jinko.pptx`',
      'Preview path: "/tmp/zspark/preview/contact-sheet.png".',
      'Not a local artifact: source.pptx or https://example.com/deck.pptx'
    ].join('\n')

    expect(extractArtifactPathCandidates(text)).toEqual([
      'outputs/manual/presentations/demo/output/Jinko.pptx',
      '/tmp/zspark/preview/contact-sheet.png'
    ])
  })

  test('resolves relative artifact paths against the runtime cwd', () => {
    expect(resolveWorkspacePath('outputs/demo.pptx', '/repo')).toBe('/repo/outputs/demo.pptx')
    expect(resolveWorkspacePath('/tmp/demo.pptx', '/repo')).toBe('/tmp/demo.pptx')
  })

  test('returns a portable dirname from a skill path', () => {
    expect(dirname('/Users/me/skills/presentations/SKILL.md')).toBe('/Users/me/skills/presentations')
  })
})
