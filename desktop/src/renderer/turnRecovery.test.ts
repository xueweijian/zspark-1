import { describe, expect, it } from 'vitest'
import {
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
