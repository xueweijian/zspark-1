import { describe, expect, test } from 'vitest'
import { artifactMimeType, contentDispositionFileName } from './mime'

describe('artifactMimeType', () => {
  test('returns office mime types for known extensions', () => {
    expect(artifactMimeType('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(artifactMimeType('REPORT.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(artifactMimeType('chart.csv')).toBe('text/csv')
  })
  test('falls back to octet-stream for unknown extensions', () => {
    expect(artifactMimeType('noext')).toBe('application/octet-stream')
    expect(artifactMimeType('weird.xyz')).toBe('application/octet-stream')
  })
})

describe('contentDispositionFileName', () => {
  test('parses RFC 5987 UTF-8 form first', () => {
    expect(contentDispositionFileName("attachment; filename*=UTF-8''hello%20world.txt")).toBe('hello world.txt')
  })
  test('falls back to quoted filename', () => {
    expect(contentDispositionFileName('attachment; filename="hi.pdf"')).toBe('hi.pdf')
  })
  test('handles unquoted filename', () => {
    expect(contentDispositionFileName('attachment; filename=plain.zip')).toBe('plain.zip')
  })
  test('returns null for missing header', () => {
    expect(contentDispositionFileName(null)).toBeNull()
    expect(contentDispositionFileName('attachment')).toBeNull()
  })
})
