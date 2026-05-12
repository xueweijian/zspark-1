import { describe, expect, it } from 'vitest'
import { shouldSuppressServerWarning } from './serverWarnings'

describe('shouldSuppressServerWarning', () => {
  it('suppresses internal compatibility warnings that should not be customer-facing', () => {
    expect(shouldSuppressServerWarning(
      '`on-failure` approval policy is deprecated and will be removed in a future release. Use `on-request` for interactive approvals or `never` for non-interactive runs.'
    )).toBe(true)
    expect(shouldSuppressServerWarning('Defaulting to fallback metadata for model foo')).toBe(true)
  })

  it('keeps actionable warnings visible', () => {
    expect(shouldSuppressServerWarning('Provider rejected request: invalid API key')).toBe(false)
    expect(shouldSuppressServerWarning('Permission denied while moving files')).toBe(false)
  })
})
