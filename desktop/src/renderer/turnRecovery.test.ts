import { describe, expect, it } from 'vitest'
import {
  shouldCountCommandExecutionAsCompletedWork,
  shouldReleaseCompletedWorkAfterProviderFailure,
  shouldRecoverFromProviderRetry,
  turnStatusAfterServerCompletion
} from './turnRecovery'

describe('shouldRecoverFromProviderRetry', () => {
  it('recovers only after completed work exists', () => {
    expect(shouldRecoverFromProviderRetry({
      willRetry: true,
      completedWorkCount: 1,
      alreadyInterrupting: false
    })).toBe(true)

    expect(shouldRecoverFromProviderRetry({
      willRetry: true,
      completedWorkCount: 0,
      alreadyInterrupting: false
    })).toBe(false)
  })

  it('does not schedule duplicate recovery for the same turn', () => {
    expect(shouldRecoverFromProviderRetry({
      willRetry: true,
      completedWorkCount: 2,
      alreadyInterrupting: true
    })).toBe(false)
  })
})

describe('shouldCountCommandExecutionAsCompletedWork', () => {
  it('ignores read-only command activity', () => {
    expect(shouldCountCommandExecutionAsCompletedWork({
      commandActions: [
        { type: 'read', command: 'sed -n 1,80p file.ts' },
        { type: 'search', command: 'rg build_artifact_deck' },
        { type: 'listFiles', command: 'find outputs -type f' }
      ],
      actionKind: 'run'
    })).toBe(false)

    expect(shouldCountCommandExecutionAsCompletedWork({
      commandActions: [{ type: 'unknown', command: 'sed -n 1,80p file.ts' }],
      actionKind: 'read'
    })).toBe(false)
  })

  it('counts commands that can produce or verify artifacts', () => {
    expect(shouldCountCommandExecutionAsCompletedWork({
      commandActions: [{ type: 'write', path: 'slides/slide-01.mjs' }],
      actionKind: 'write'
    })).toBe(true)

    expect(shouldCountCommandExecutionAsCompletedWork({
      commandActions: [{ type: 'unknown', command: 'node build_artifact_deck.mjs' }],
      actionKind: 'build'
    })).toBe(true)
  })
})

describe('shouldReleaseCompletedWorkAfterProviderFailure', () => {
  it('releases final stream disconnects after local work was recorded', () => {
    expect(shouldReleaseCompletedWorkAfterProviderFailure({
      willRetry: false,
      completedWorkCount: 1,
      alreadyInterrupting: false,
      isStreamDisconnect: true
    })).toBe(true)

    expect(shouldReleaseCompletedWorkAfterProviderFailure({
      willRetry: false,
      completedWorkCount: 0,
      alreadyInterrupting: false,
      isStreamDisconnect: true
    })).toBe(false)
  })

  it('does not hide retrying or non-stream provider failures', () => {
    expect(shouldReleaseCompletedWorkAfterProviderFailure({
      willRetry: true,
      completedWorkCount: 1,
      alreadyInterrupting: false,
      isStreamDisconnect: true
    })).toBe(false)

    expect(shouldReleaseCompletedWorkAfterProviderFailure({
      willRetry: false,
      completedWorkCount: 1,
      alreadyInterrupting: false,
      isStreamDisconnect: false
    })).toBe(false)
  })
})

describe('turnStatusAfterServerCompletion', () => {
  it('does not let a late failed completion override a locally released turn', () => {
    expect(turnStatusAfterServerCompletion({
      serverStatus: 'failed',
      locallyReleased: true
    })).toBe('interrupted')
  })

  it('keeps normal server completion states unchanged', () => {
    expect(turnStatusAfterServerCompletion({
      serverStatus: 'failed',
      locallyReleased: false
    })).toBe('failed')

    expect(turnStatusAfterServerCompletion({
      serverStatus: 'interrupted',
      locallyReleased: true
    })).toBe('interrupted')

    expect(turnStatusAfterServerCompletion({
      serverStatus: 'completed',
      locallyReleased: false
    })).toBe('completed')
  })
})
