import type { ApprovalDecisionMode, ApprovalRequest, ApprovalStatus } from './appTypes'

export function approvalStatusLabel(status: ApprovalStatus) {
  switch (status) {
    case 'pending': return 'Needs approval'
    case 'sending': return 'Sending decision'
    case 'approved': return 'Approved'
    case 'approvedAll': return 'Approved all'
    case 'denied': return 'Denied'
    case 'resolved': return 'No longer needed'
  }
}

export function approvalTopline(status: ApprovalStatus) {
  switch (status) {
    case 'pending':
    case 'sending':
      return 'Approval required'
    case 'approved':
    case 'approvedAll':
    case 'resolved':
      return 'Approval granted'
    case 'denied':
      return 'Approval denied'
  }
}

export function availableDecisionNames(params: any) {
  const decisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : []
  return decisions.flatMap((decision: any) => {
    if (typeof decision === 'string') return [decision]
    if (!decision || typeof decision !== 'object') return []
    return Object.keys(decision)
  })
}

function decisionAvailable(params: any, decision: string) {
  const names = availableDecisionNames(params)
  return names.length === 0 || names.includes(decision)
}

function explicitDecisionAvailable(params: any, decision: string) {
  return availableDecisionNames(params).includes(decision)
}

export function approvalSupportsApproveAll(request: ApprovalRequest) {
  if (request.kind === 'permissions') return true
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') return false
  if (explicitDecisionAvailable(request.params, 'acceptForSession')) return true
  return explicitDecisionAvailable(request.params, 'acceptWithExecpolicyAmendment')
    && Array.isArray(request.params?.proposedExecpolicyAmendment)
}

export function approvalDecision(params: any, mode: ApprovalDecisionMode) {
  if (mode === 'deny') {
    return decisionAvailable(params, 'decline') ? 'decline' : 'cancel'
  }
  if (mode === 'approveAll') {
    if (explicitDecisionAvailable(params, 'acceptForSession')) return 'acceptForSession'
    if (explicitDecisionAvailable(params, 'acceptWithExecpolicyAmendment') && Array.isArray(params?.proposedExecpolicyAmendment)) {
      return {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: params.proposedExecpolicyAmendment
        }
      }
    }
  }
  return 'accept'
}

export function grantedPermissionsFromRequest(permissions: any) {
  const granted: any = {}
  if (permissions?.network?.enabled) granted.network = { enabled: true }
  const fs = permissions?.fileSystem
  if (fs) {
    const fileSystem: any = {}
    if (Array.isArray(fs.read) && fs.read.length) fileSystem.read = fs.read
    if (Array.isArray(fs.write) && fs.write.length) fileSystem.write = fs.write
    if (Array.isArray(fs.entries) && fs.entries.length) fileSystem.entries = fs.entries
    if (typeof fs.globScanMaxDepth === 'number') fileSystem.globScanMaxDepth = fs.globScanMaxDepth
    if (Object.keys(fileSystem).length) granted.fileSystem = fileSystem
  }
  return granted
}

export function approvalStatusForDecision(mode: ApprovalDecisionMode): ApprovalStatus {
  if (mode === 'deny') return 'denied'
  return mode === 'approveAll' ? 'approvedAll' : 'approved'
}

export function approvalResponsePayload(request: ApprovalRequest, mode: ApprovalDecisionMode) {
  const effectiveMode = mode === 'approveAll' && !approvalSupportsApproveAll(request) ? 'approve' : mode
  const approved = mode !== 'deny'
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    if (!approved) return { decision: 'denied' }
    return { decision: effectiveMode === 'approveAll' ? 'approved_for_session' : 'approved' }
  }
  if (request.kind === 'permissions') {
    return approved
      ? {
          scope: effectiveMode === 'approveAll' ? 'session' : 'turn',
          permissions: grantedPermissionsFromRequest(request.params?.permissions)
        }
      : { scope: 'turn', permissions: {} }
  }
  return { decision: approvalDecision(request.params, effectiveMode) }
}
