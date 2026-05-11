import { describe, expect, test } from 'vitest'
import { normalizeMarkdownForDisplay } from './markdown'

describe('normalizeMarkdownForDisplay', () => {
  test('collapses excessive blank lines outside code fences', () => {
    expect(normalizeMarkdownForDisplay('## Title\n\n\n\n- one\n\n\n- two\n')).toBe('## Title\n\n- one\n\n- two')
  })

  test('preserves blank lines inside fenced code blocks', () => {
    const input = 'Before\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n\nAfter'
    expect(normalizeMarkdownForDisplay(input)).toBe('Before\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nAfter')
  })

  test('removes upstream channel markers before rendering', () => {
    const input = '<|channel>thought\n<channel|><|channel>thought\n<channel|>Final answer'
    expect(normalizeMarkdownForDisplay(input)).toBe('Final answer')
  })
})
