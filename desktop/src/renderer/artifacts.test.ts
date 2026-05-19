import { describe, expect, test } from 'vitest'
import {
  dirname,
  extractDisplayableArtifactPathCandidates,
  extractArtifactPathCandidates,
  findRecentArtifactForCandidate,
  isDisplayableArtifactPath,
  resolveWorkspacePath
} from './artifacts'

describe('artifact helpers', () => {
  test('extracts workspace artifact paths from assistant text', () => {
    const text = [
      'Final file: `outputs/manual/presentations/demo/output/Jinko.pptx`',
      'Short verified file: `PPO-RL.pptx`',
      'Preview path: "/tmp/zspark/preview/contact-sheet.png".',
      'Not a local artifact: source.pptx or https://example.com/deck.pptx'
    ].join('\n')

    expect(extractArtifactPathCandidates(text)).toEqual([
      'outputs/manual/presentations/demo/output/Jinko.pptx',
      'PPO-RL.pptx',
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

  test('matches recent artifacts by suffix or basename for relative output claims', () => {
    const artifact = {
      name: 'Year-End-Review.pptx',
      path: '/repo/outputs/manual-year-end/presentations/year-end/output/Year-End-Review.pptx',
      size: 123,
      mtimeMs: 456
    }
    const artifacts = [artifact]

    expect(findRecentArtifactForCandidate('output/Year-End-Review.pptx', artifacts)).toEqual(artifact)
    expect(findRecentArtifactForCandidate('outputs/final/Year-End-Review.pptx', artifacts)).toEqual(artifact)
    expect(findRecentArtifactForCandidate('outputs/final/Missing.pptx', artifacts)).toBeNull()
  })

  test('only treats final deliverables as displayable artifacts', () => {
    expect(isDisplayableArtifactPath('/repo/outputs/run/presentations/demo/output/final.pptx')).toBe(true)
    expect(isDisplayableArtifactPath('/repo/outputs/run/presentations/demo/package.json')).toBe(false)
    expect(isDisplayableArtifactPath('/repo/outputs/run/presentations/demo/slides/slide-01.mjs')).toBe(false)
    expect(isDisplayableArtifactPath('/repo/outputs/run/presentations/demo/preview/slide-01.png')).toBe(false)
    expect(isDisplayableArtifactPath('https://example.com/final.pptx')).toBe(false)
  })

  test('extracts command-output artifacts without preview scratch files', () => {
    const output = JSON.stringify({
      output: '/repo/outputs/run/presentations/demo/output/final.pptx',
      previewPaths: [
        '/repo/outputs/run/presentations/demo/preview/slide-01.png',
        '/repo/outputs/run/presentations/demo/preview/slide-02.png'
      ],
      contactSheet: '/repo/outputs/run/presentations/demo/qa/contact-sheet.png'
    }, null, 2)

    expect(extractDisplayableArtifactPathCandidates(output)).toEqual([
      '/repo/outputs/run/presentations/demo/output/final.pptx'
    ])
  })

  test('prioritizes Office-style deliverables over displayable images', () => {
    const output = [
      'Image: /repo/outputs/run/gallery/final.png',
      'Deck: /repo/outputs/run/presentations/demo/output/final.pptx'
    ].join('\n')

    expect(extractDisplayableArtifactPathCandidates(output)).toEqual([
      '/repo/outputs/run/presentations/demo/output/final.pptx',
      '/repo/outputs/run/gallery/final.png'
    ])
  })

})
