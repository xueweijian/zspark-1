import { describe, expect, test } from 'vitest'
import {
  cleanShellCommand,
  inferActionKindFromTitle,
  inferCommandInfo,
  normalizeActivity,
  publicActivityTitleText,
  shortenCommand,
  timestampToMs,
  truncateActivityDetail
} from './activityHelpers'

describe('cleanShellCommand', () => {
  test('strips bash -lc wrapper and outer quotes', () => {
    expect(cleanShellCommand("/bin/bash -lc 'ls -la'")).toBe('ls -la')
    expect(cleanShellCommand('plain command  ')).toBe('plain command')
  })
})

describe('shortenCommand', () => {
  test('truncates with ellipsis at limit', () => {
    expect(shortenCommand('a'.repeat(100), 10)).toBe('aaaaaaaaa…')
  })
  test('returns first line', () => {
    expect(shortenCommand('first\nsecond')).toBe('first')
  })
})

describe('inferCommandInfo', () => {
  test('classifies common command shapes', () => {
    expect(inferCommandInfo('rg foo').title).toBe('Inspected project context')
    expect(inferCommandInfo('git status').title).toBe('Checked git status')
    expect(inferCommandInfo('npm run test').title).toBe('Ran quality checks')
    expect(inferCommandInfo('something weird').title).toBe('Ran workspace step')
  })
})

describe('inferActionKindFromTitle', () => {
  test('maps verbs in titles to action kinds', () => {
    expect(inferActionKindFromTitle('Read file')).toBe('read')
    expect(inferActionKindFromTitle('Wrote update')).toBe('write')
    expect(inferActionKindFromTitle('Searched workspace')).toBe('search')
    expect(inferActionKindFromTitle('')).toBeUndefined()
  })
})

describe('truncateActivityDetail', () => {
  test('returns trimmed string under limit', () => {
    expect(truncateActivityDetail('  hi  ')).toBe('hi')
  })
  test('keeps tail and prefixes notice when truncated', () => {
    const out = truncateActivityDetail('a'.repeat(200), 50)
    expect(out?.startsWith('Output truncated to last 50 characters.')).toBe(true)
    expect(out?.endsWith('a'.repeat(50))).toBe(true)
  })
})

describe('normalizeActivity', () => {
  test('rejects malformed records', () => {
    expect(normalizeActivity(null)).toBeNull()
    expect(normalizeActivity({ id: 1, title: 't' })).toBeNull()
    expect(normalizeActivity({ id: 'x', title: 't' })?.kind).toBe('reasoning')
  })
})

describe('timestampToMs', () => {
  test('handles seconds, ms, and bad input', () => {
    expect(timestampToMs(1700000000)).toBe(1700000000000)
    expect(timestampToMs(1700000000000)).toBe(1700000000000)
    expect(timestampToMs(undefined, 42)).toBe(42)
  })
})

describe('publicActivityTitleText', () => {
  test('rewrites known noisy titles', () => {
    expect(publicActivityTitleText('Read SKILL.md')).toBe('Loaded presentation skill')
    expect(publicActivityTitleText('tool call')).toBe('Used tool')
    expect(publicActivityTitleText('Custom step')).toBe('Custom step')
  })
})
