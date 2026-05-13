import { describe, expect, test } from 'vitest'
import {
  basename,
  blocksFromSharedSnapshot,
  changeKindLabel,
  describeChange,
  displaySkillName,
  displayThreadPreview,
  fmtBytes,
  fmtDuration,
  formatUserInputContent,
  isSharedArtifactPath,
  scopeLabel,
  sharedArtifactPath,
  stripInternalPromptContext,
  titleFromBlocks,
  upsertApprovalBlockByTurnOrder
} from './appHelpers'

describe('formatting', () => {
  test('fmtDuration', () => {
    expect(fmtDuration(0)).toBe('<1s')
    expect(fmtDuration(45_000)).toBe('45s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
  })
  test('fmtBytes', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024 * 5)).toBe('5.0 KB')
    expect(fmtBytes(1024 * 1024 * 12)).toBe('12 MB')
  })
  test('basename', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt')
    expect(basename('C:\\\\foo\\\\bar.csv')).toBe('bar.csv')
  })
})

describe('content helpers', () => {
  test('stripInternalPromptContext removes skill prelude', () => {
    expect(stripInternalPromptContext('Hello\n\nUse skill: foo')).toBe('Hello')
  })
  test('formatUserInputContent collapses skill-only inputs', () => {
    expect(formatUserInputContent([{ type: 'skill', name: 'work:report' }])).toBe('Using report')
  })
  test('displaySkillName trims namespace', () => {
    expect(displaySkillName('work:report')).toBe('report')
  })
})

describe('changes / shared artifacts', () => {
  test('changeKindLabel maps kinds', () => {
    expect(changeKindLabel({ type: 'add' })).toBe('created')
    expect(changeKindLabel('delete')).toBe('deleted')
    expect(changeKindLabel('update')).toBe('modified')
  })
  test('describeChange surfaces moves', () => {
    expect(describeChange({ type: 'update', movePath: 'old.md' })).toBe('Moved from old.md')
  })
  test('shared artifact paths round-trip', () => {
    const p = sharedArtifactPath('w', 's', 'a', 'name.txt')
    expect(p).toBe('shared://w/s/a/name.txt')
    expect(isSharedArtifactPath(p)).toBe(true)
    expect(isSharedArtifactPath('/local/file')).toBe(false)
  })
})

describe('thread / scope helpers', () => {
  test('displayThreadPreview falls back to id slice', () => {
    expect(displayThreadPreview({ id: 'abcdef0123' })).toBe('abcdef01')
    expect(displayThreadPreview({ id: '123', preview: 'hi' })).toBe('hi')
  })
  test('titleFromBlocks reads first user line', () => {
    expect(titleFromBlocks([{ type: 'user', id: '1', text: 'Hello there' }] as any)).toBe('Hello there')
  })
  test('scopeLabel maps scopes', () => {
    expect(scopeLabel('repo')).toBe('Project')
    expect(scopeLabel(undefined)).toBe('Skill')
  })
})

describe('blocksFromSharedSnapshot', () => {
  test('drops unknown block types', () => {
    const out = blocksFromSharedSnapshot({ blocks: [{ type: 'mystery' }, { type: 'user', id: '1', text: 'hi' }] as any })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('user')
  })
  test('drops malformed known block types before rendering', () => {
    const out = blocksFromSharedSnapshot({
      blocks: [
        { type: 'files', id: 'bad', turnId: 't1', title: 'files' },
        { type: 'turn', id: 'bad-turn', turnId: 't1' },
        { type: 'agent', id: 'ok', text: 'done' }
      ] as any
    })
    expect(out).toEqual([{ type: 'agent', id: 'ok', text: 'done', turnId: undefined, memoryCitation: null }])
  })
  test('normalizes nested file and activity arrays', () => {
    const out = blocksFromSharedSnapshot({
      blocks: [
        { type: 'files', id: 'f', turnId: 't1', title: 'files', files: [{ id: 'x', name: 'a.txt', path: '/tmp/a.txt', source: 'bad', status: 'bad', updatedAt: 1 }] },
        { type: 'turn', id: 'turn', turnId: 't1', collapsed: false, startedAt: 1, status: 'interrupted', activities: [{ id: 'a', kind: 'command', title: 'Ran', status: 'running', startedAt: 1 }, { id: 2, title: 'bad' }] }
      ] as any
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'files', files: [{ source: 'change', status: 'missing' }] })
    expect(out[1]).toMatchObject({ type: 'turn', status: 'interrupted', activities: [{ id: 'a', kind: 'command', status: 'running' }] })
  })
})

describe('upsertApprovalBlockByTurnOrder', () => {
  test('adds newer approvals after older same-turn blocks', () => {
    const blocks = [
      { type: 'user', id: 'u', text: 'make a deck', turnId: 't1' },
      { type: 'turn', id: 't', turnId: 't1', activities: [], collapsed: false, startedAt: 1 },
      { type: 'approval', id: 'a1', turnId: 't1', request: { key: 'a1' } },
      { type: 'agent', id: 'm', text: 'working', turnId: 't1' }
    ] as any
    const next = upsertApprovalBlockByTurnOrder(blocks, { type: 'approval', id: 'a2', turnId: 't1', request: { key: 'a2' } } as any)
    expect(next.map((block) => block.id)).toEqual(['u', 't', 'a1', 'm', 'a2'])
  })

  test('replaces an existing approval in place', () => {
    const blocks = [
      { type: 'approval', id: 'old', turnId: 't1', request: { key: 'same', status: 'pending' } },
      { type: 'approval', id: 'later', turnId: 't1', request: { key: 'later' } }
    ] as any
    const next = upsertApprovalBlockByTurnOrder(blocks, { type: 'approval', id: 'new', turnId: 't1', request: { key: 'same', status: 'approvedAll' } } as any)
    expect(next.map((block) => block.id)).toEqual(['new', 'later'])
  })
})
