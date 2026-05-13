import { describe, expect, test } from 'vitest'
import { approvalDecision, approvalResponsePayload, approvalStatusLabel } from './approvalHelpers'
import type { ApprovalRequest } from './appTypes'

function request(partial: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 1,
    key: '1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    blockId: 'approval-1',
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    title: 'Run command',
    description: 'Approval required',
    paths: [],
    params: {},
    status: 'pending',
    startedAt: 1,
    ...partial
  }
}

describe('approvalDecision', () => {
  test('keeps approve scoped to one prompt', () => {
    expect(approvalDecision({ availableDecisions: ['accept', 'acceptForSession'] }, 'approve')).toBe('accept')
  })

  test('uses session approval for approve all', () => {
    expect(approvalDecision({ availableDecisions: ['accept', 'acceptForSession'] }, 'approveAll')).toBe('acceptForSession')
  })

  test('falls back to execpolicy amendment when session approval is unavailable', () => {
    expect(approvalDecision({
      availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node'] } }],
      proposedExecpolicyAmendment: ['node']
    }, 'approveAll')).toEqual({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['node']
      }
    })
  })
})

describe('approvalResponsePayload', () => {
  test('approves permissions for the whole session when requested', () => {
    const payload = approvalResponsePayload(request({
      kind: 'permissions',
      method: 'item/permissions/requestApproval',
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: { write: ['/workspace'] }
        }
      }
    }), 'approveAll')
    expect(payload).toEqual({
      scope: 'session',
      permissions: {
        network: { enabled: true },
        fileSystem: { write: ['/workspace'] }
      }
    })
  })

  test('labels approve all distinctly', () => {
    expect(approvalStatusLabel('approvedAll')).toBe('Approved all')
  })
})
