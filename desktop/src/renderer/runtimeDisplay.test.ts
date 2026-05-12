import { describe, expect, test } from 'vitest'
import { formatApprovalPolicy, formatSandboxPolicy, shortPath } from './runtimeDisplay'

describe('runtime display helpers', () => {
  test('formats sandbox policies from app-server responses', () => {
    expect(formatSandboxPolicy({ type: 'dangerFullAccess' })).toBe('Danger full access')
    expect(formatSandboxPolicy({ type: 'workspaceWrite', networkAccess: false })).toBe('Workspace write · no network')
    expect(formatSandboxPolicy(null, { type: 'disabled' })).toBe('Disabled')
  })

  test('formats approval policy and short paths', () => {
    expect(formatApprovalPolicy('on-request')).toBe('On request')
    expect(formatApprovalPolicy('on-failure')).toBe('On failure')
    expect(shortPath('/Users/example/projects/zspark/desktop', 24)).toBe('…/zspark/desktop')
  })
})
