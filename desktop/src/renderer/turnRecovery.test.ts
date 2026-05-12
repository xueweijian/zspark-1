import { describe, expect, it } from 'vitest'
import {
  shouldRecoverFromCompletedWorkStall,
  shouldRecoverFromProviderRetry
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

describe('shouldRecoverFromCompletedWorkStall', () => {
  it('recovers stalled finalization after completed work', () => {
    expect(shouldRecoverFromCompletedWorkStall({
      completedWorkCount: 1,
      alreadyInterrupting: false
    })).toBe(true)

    expect(shouldRecoverFromCompletedWorkStall({
      completedWorkCount: 0,
      alreadyInterrupting: false
    })).toBe(false)
  })
})
