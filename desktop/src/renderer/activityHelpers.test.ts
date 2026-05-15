import { describe, expect, test } from 'vitest'
import {
  cleanShellCommand,
  deletedArtifactReference,
  deletedArtifactReferenceMatchesCandidate,
  extractDeletedPathsFromCommand,
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

describe('extractDeletedPathsFromCommand', () => {
  test('uses structured delete commandActions when present', () => {
    const paths = extractDeletedPathsFromCommand({
      command: 'whatever the assistant typed',
      commandActions: [
        { type: 'delete', path: 'C:\\Users\\u\\Desktop\\Year-End-Review.pptx' },
        { type: 'read', path: 'C:\\Users\\u\\Desktop\\notes.md' }
      ]
    })
    expect(paths).toEqual(['C:\\Users\\u\\Desktop\\Year-End-Review.pptx'])
  })

  test('uses parsed commandActions commands when the top-level command is unavailable', () => {
    const paths = extractDeletedPathsFromCommand({
      commandActions: [
        { type: 'unknown', command: 'Remove-Item C:\\Users\\u\\Desktop\\Year-End-Review.pptx -Force' },
        { type: 'read', command: 'Get-Content C:\\Users\\u\\Desktop\\notes.md', path: 'C:\\Users\\u\\Desktop\\notes.md' }
      ]
    })
    expect(paths).toEqual(['C:\\Users\\u\\Desktop\\Year-End-Review.pptx'])
  })

  test('parses rm/del/Remove-Item across shells without depending on output language', () => {
    expect(extractDeletedPathsFromCommand({ command: 'rm -f foo.pptx bar.pptx' })).toEqual(['foo.pptx', 'bar.pptx'])
    expect(extractDeletedPathsFromCommand({ command: 'del C:\\tmp\\a.pptx' })).toEqual(['C:\\tmp\\a.pptx'])
    expect(extractDeletedPathsFromCommand({ command: 'Remove-Item "C:\\tmp\\b.pptx" -Force' })).toEqual(['C:\\tmp\\b.pptx'])
  })

  test('unwraps Windows shell command wrappers before parsing deletes', () => {
    expect(extractDeletedPathsFromCommand({
      command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Remove-Item \'C:\\tmp\\wrapped deck.pptx\' -Force"'
    })).toEqual(['C:\\tmp\\wrapped deck.pptx'])
    expect(extractDeletedPathsFromCommand({
      command: 'cmd.exe /c del /q C:\\tmp\\cmd-deck.pptx'
    })).toEqual(['C:\\tmp\\cmd-deck.pptx'])
    expect(extractDeletedPathsFromCommand({
      command: 'cmd.exe /c rmdir /s /q "C:\\tmp\\old deck"'
    })).toEqual(['C:\\tmp\\old deck'])
  })

  test('ignores non-delete commands', () => {
    expect(extractDeletedPathsFromCommand({ command: 'ls -la' })).toEqual([])
    expect(extractDeletedPathsFromCommand({ command: 'cat foo.pptx' })).toEqual([])
  })
})

describe('deleted artifact reference matching', () => {
  test('suppresses only within the same turn', () => {
    const ref = deletedArtifactReference('turn-1', 'C:\\tmp\\deck.pptx')

    expect(ref).not.toBeNull()
    expect(deletedArtifactReferenceMatchesCandidate('turn-1', 'C:\\tmp\\deck.pptx', [ref!])).toBe(true)
    expect(deletedArtifactReferenceMatchesCandidate('turn-2', 'C:\\tmp\\deck.pptx', [ref!])).toBe(false)
  })

  test('uses basename fallback only for bare assistant references', () => {
    const ref = deletedArtifactReference('turn-1', 'C:\\tmp\\deck.pptx')

    expect(deletedArtifactReferenceMatchesCandidate('turn-1', 'deck.pptx', [ref!])).toBe(true)
    expect(deletedArtifactReferenceMatchesCandidate('turn-1', 'outputs/deck.pptx', [ref!])).toBe(false)
  })
})
