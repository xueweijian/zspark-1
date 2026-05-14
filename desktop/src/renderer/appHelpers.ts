/**
 * Pure formatting helpers used by the renderer. No React, no IPC.
 * Every function here is testable in isolation.
 */
import type {
  Activity,
  ApprovalRequest,
  Block,
  SharedArtifact,
  SharedSession,
  SharedSessionSnapshot,
  SkillMeta,
  ThreadSummary,
  TurnInputItem,
  WorkspaceFile
} from './appTypes'

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * Drop the boilerplate prefix that we tack onto user prompts (skill
 * preludes, attachment hints, runtime context, …). Used for thread
 * previews and visible echoes so the UI shows what the user typed, not
 * what the agent actually receives.
 */
export function stripInternalPromptContext(text: string): string {
  const raw = String(text ?? '')
  const marker = raw.search(
    /(?:^|\n\s*\n)\s*(?:Use skill:|Attached file:|Attached image:|Zspark local runtime|Zspark execution safety:|Hard delivery contract:|Before using @oai\/artifact-tool|Before the final answer|For PPTX\/presentation tasks|The final response must|\[Skill:)/
  )
  return (marker === -1 ? raw : raw.slice(0, marker)).trim()
}

export function displaySkillName(name?: string): string {
  const raw = String(name ?? 'selected skill')
  return raw.split(':').pop() || raw
}

export function displayThreadPreview(thread: ThreadSummary): string {
  const label = stripInternalPromptContext(thread.preview?.trim() || thread.name || '')
  return label || thread.id.slice(0, 8)
}

export function sharedSessionToThread(session: SharedSession): ThreadSummary {
  const updated = session.updated_at ? Math.floor(new Date(session.updated_at).getTime() / 1000) : undefined
  const created = session.created_at ? Math.floor(new Date(session.created_at).getTime() / 1000) : undefined
  return {
    id: session.id,
    name: session.title ?? undefined,
    preview: session.title ?? undefined,
    createdAt: Number.isFinite(created) ? created : undefined,
    updatedAt: Number.isFinite(updated) ? updated : undefined
  }
}

export function titleFromBlocks(blocks: Block[]): string {
  const user = blocks.find((block): block is Extract<Block, { type: 'user' }> => block.type === 'user')
  const title = stripInternalPromptContext(user?.text ?? '').split('\n').find(Boolean)?.trim()
  return (title || 'New shared chat').slice(0, 120)
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  return value.slice(0, limit)
}

function optionalBoundedString(value: unknown, limit: number): string | undefined {
  return value == null ? undefined : boundedString(value, limit) ?? undefined
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const ACTIVITY_KINDS = new Set(['reasoning', 'command', 'file', 'tool', 'web', 'memory'])
const ACTION_KINDS = new Set(['read', 'write', 'list', 'search', 'run', 'build', 'verify', 'tool', 'file'])
const ACTIVITY_STATUSES = new Set(['running', 'done', 'failed'])
const FILE_SOURCES = new Set(['attachment', 'change'])
const FILE_STATUSES = new Set(['attached', 'created', 'modified', 'deleted', 'missing'])
const APPROVAL_KINDS = new Set(['command', 'fileChange', 'permissions'])
const APPROVAL_STATUSES = new Set(['pending', 'sending', 'approved', 'approvedAll', 'denied', 'resolved'])
const TURN_BLOCK_STATUSES = new Set(['running', 'completed', 'interrupted', 'failed'])

function normalizeSnapshotActivity(activity: any): Activity | null {
  if (!activity || typeof activity !== 'object') return null
  const id = boundedString(activity.id, 240)
  const title = boundedString(activity.title, 500)
  if (!id || !title) return null
  return {
    id,
    kind: ACTIVITY_KINDS.has(activity.kind) ? activity.kind : 'reasoning',
    title,
    detail: optionalBoundedString(activity.detail, 6000),
    actionKind: ACTION_KINDS.has(activity.actionKind) ? activity.actionKind : undefined,
    target: optionalBoundedString(activity.target, 1200),
    status: ACTIVITY_STATUSES.has(activity.status) ? activity.status : 'done',
    startedAt: finiteNumber(activity.startedAt, 0),
    endedAt: activity.endedAt == null ? undefined : finiteNumber(activity.endedAt)
  }
}

function normalizeSnapshotWorkspaceFile(file: any): WorkspaceFile | null {
  if (!file || typeof file !== 'object') return null
  const id = boundedString(file.id, 240)
  const name = boundedString(file.name, 240)
  const path = boundedString(file.path, 1400)
  if (!id || !name || !path) return null
  return {
    id,
    name,
    path,
    source: FILE_SOURCES.has(file.source) ? file.source : 'change',
    status: FILE_STATUSES.has(file.status) ? file.status : 'missing',
    detail: optionalBoundedString(file.detail, 1000),
    updatedAt: finiteNumber(file.updatedAt, Date.now()),
    sharedArtifact: file.sharedArtifact && typeof file.sharedArtifact === 'object'
      ? {
          workspaceId: String(file.sharedArtifact.workspaceId ?? '').slice(0, 160),
          sessionId: String(file.sharedArtifact.sessionId ?? '').slice(0, 160),
          artifactId: String(file.sharedArtifact.artifactId ?? '').slice(0, 160),
          sizeBytes: file.sharedArtifact.sizeBytes == null ? undefined : finiteNumber(file.sharedArtifact.sizeBytes)
        }
      : undefined
  }
}

function normalizeSnapshotApprovalRequest(request: any): ApprovalRequest | null {
  if (!request || typeof request !== 'object') return null
  const key = boundedString(request.key, 240)
  const method = boundedString(request.method, 160)
  const blockId = boundedString(request.blockId, 240)
  const threadId = boundedString(request.threadId, 240)
  const turnId = boundedString(request.turnId, 240)
  const itemId = boundedString(request.itemId, 240)
  const title = boundedString(request.title, 500)
  const description = boundedString(request.description, 1000)
  if (!key || !method || !blockId || !threadId || !turnId || !itemId || !title || !description) return null
  return {
    id: typeof request.id === 'number' || typeof request.id === 'string' ? request.id : key,
    key,
    kind: APPROVAL_KINDS.has(request.kind) ? request.kind : 'permissions',
    method,
    blockId,
    threadId,
    turnId,
    itemId,
    title,
    description,
    detail: optionalBoundedString(request.detail, 3000),
    commandPreview: optionalBoundedString(request.commandPreview, 3000),
    cwd: optionalBoundedString(request.cwd, 1200),
    reason: optionalBoundedString(request.reason, 1000),
    paths: Array.isArray(request.paths) ? request.paths.map((path: any) => String(path).slice(0, 1200)).slice(0, 200) : [],
    params: request.params,
    status: APPROVAL_STATUSES.has(request.status) ? request.status : 'resolved',
    startedAt: finiteNumber(request.startedAt, Date.now())
  }
}

function normalizeSnapshotBlock(block: any): Block | null {
  if (!block || typeof block !== 'object') return null
  const id = boundedString(block.id, 240)
  if (!id) return null
  if (block.type === 'user') {
    const text = boundedString(block.text, 200_000)
    if (text == null) return null
    return { type: 'user', id, text, turnId: optionalBoundedString(block.turnId, 240), input: Array.isArray(block.input) ? normalizeInputItemsForResubmit(block.input).slice(0, 200) : undefined }
  }
  if (block.type === 'agent') {
    const text = boundedString(block.text, 1_000_000)
    if (text == null) return null
    return { type: 'agent', id, text, turnId: optionalBoundedString(block.turnId, 240), memoryCitation: block.memoryCitation ?? null }
  }
  if (block.type === 'files') {
    const turnId = boundedString(block.turnId, 240)
    const title = boundedString(block.title, 500)
    if (!turnId || !title || !Array.isArray(block.files)) return null
    return {
      type: 'files',
      id,
      turnId,
      title,
      files: block.files.map(normalizeSnapshotWorkspaceFile).filter((file: WorkspaceFile | null): file is WorkspaceFile => Boolean(file)).slice(0, 300),
      subtitle: optionalBoundedString(block.subtitle, 1000),
      tone: block.tone === 'warn' ? 'warn' : block.tone === 'normal' ? 'normal' : undefined
    }
  }
  if (block.type === 'approval') {
    const turnId = boundedString(block.turnId, 240)
    const request = normalizeSnapshotApprovalRequest(block.request)
    if (!turnId || !request) return null
    return { type: 'approval', id, turnId, request }
  }
  if (block.type === 'turn') {
    const turnId = boundedString(block.turnId, 240)
    if (!turnId || !Array.isArray(block.activities)) return null
    return {
      type: 'turn',
      id,
      turnId,
      activities: block.activities.map(normalizeSnapshotActivity).filter((activity: Activity | null): activity is Activity => Boolean(activity)).slice(0, 1000),
      collapsed: Boolean(block.collapsed),
      finalMessageId: optionalBoundedString(block.finalMessageId, 240),
      startedAt: finiteNumber(block.startedAt, Date.now()),
      endedAt: block.endedAt == null ? undefined : finiteNumber(block.endedAt),
      status: TURN_BLOCK_STATUSES.has(block.status) ? block.status : undefined
    }
  }
  return null
}

export function blocksFromSharedSnapshot(snapshot?: SharedSessionSnapshot | null): Block[] {
  const blocks = Array.isArray(snapshot?.blocks) ? snapshot.blocks : []
  return blocks
    .map(normalizeSnapshotBlock)
    .filter((block: Block | null): block is Block => Boolean(block))
}

export function upsertApprovalBlockByTurnOrder(blocks: Block[], block: Extract<Block, { type: 'approval' }>): Block[] {
  const existing = blocks.findIndex((candidate) => candidate.type === 'approval' && candidate.request.key === block.request.key)
  if (existing !== -1) return blocks.map((candidate, index) => (index === existing ? block : candidate))

  let insertAfter = -1
  blocks.forEach((candidate, index) => {
    if ('turnId' in candidate && candidate.turnId === block.turnId) insertAfter = index
  })
  if (insertAfter === -1) return [...blocks, block]
  return [...blocks.slice(0, insertAfter + 1), block, ...blocks.slice(insertAfter + 1)]
}

export function formatUserInputContent(content: any[]): string {
  const visible: string[] = []
  const skills: string[] = []
  for (const c of content) {
    if (c?.type === 'text') {
      const text = stripInternalPromptContext(c.text ?? '')
      if (text) visible.push(text)
      continue
    }
    if (c?.type === 'image') {
      visible.push(`[Image: ${c.url?.startsWith?.('data:') ? 'attached image' : c.url ?? 'attached image'}]`)
      continue
    }
    if (c?.type === 'localImage') {
      visible.push(`[Image: ${basename(String(c.path ?? 'attached image'))}]`)
      continue
    }
    if (c?.type === 'skill') {
      skills.push(displaySkillName(c.name))
      continue
    }
    if (c?.type === 'mention') {
      visible.push(`[Mention: ${c.name ?? 'selected mention'}]`)
    }
  }
  if (visible.length) return visible.join('\n')
  if (skills.length) return `Using ${skills.join(', ')}`
  return ''
}

export function normalizeInputItemsForResubmit(content: any[]): TurnInputItem[] {
  const items: TurnInputItem[] = []
  for (const c of content) {
    if (c?.type === 'text') {
      const text = String(c.text ?? '')
      if (text) items.push({ type: 'text', text, textElements: c.textElements ?? c.text_elements ?? [] })
      continue
    }
    if (c?.type === 'image' && c.url) {
      items.push({ type: 'image', url: String(c.url) })
      continue
    }
    if (c?.type === 'localImage' && c.path) {
      items.push({ type: 'localImage', path: String(c.path) })
      continue
    }
    if (c?.type === 'skill' && c.name && c.path) {
      items.push({ type: 'skill', name: String(c.name), path: String(c.path) })
      continue
    }
    if (c?.type === 'mention' && c.name && c.path) {
      items.push({ type: 'mention', name: String(c.name), path: String(c.path) })
    }
  }
  return items
}

export function scopeLabel(scope?: string): string {
  switch (scope) {
    case 'repo':   return 'Project'
    case 'user':   return 'User'
    case 'system': return 'System'
    case 'admin':  return 'Admin'
    default:       return 'Skill'
  }
}

export function localSkillSourceLabel(source?: string): string {
  switch (source) {
    case 'workspace':   return 'Project'
    case 'pluginCache': return 'Plugin cache'
    case 'system':      return 'System'
    case 'user':        return 'User'
    default:            return source ?? 'Local'
  }
}

export function skillStatusLabel(skill: SkillMeta): string {
  if (skill.availability === 'localOnly') return 'Detected'
  if (skill.enabled === false) return 'Disabled'
  return 'Ready'
}

export function skillStatusClass(skill: SkillMeta): string {
  if (skill.availability === 'localOnly') return 'local'
  if (skill.enabled === false) return 'disabled'
  return 'ready'
}

export function changeKindLabel(kind: any): WorkspaceFile['status'] {
  if (kind?.type === 'add' || kind === 'add') return 'created'
  if (kind?.type === 'delete' || kind === 'delete') return 'deleted'
  return 'modified'
}

export function describeChange(kind: any): string {
  if (kind?.type === 'update' && kind.movePath) return `Moved from ${kind.movePath}`
  return changeKindLabel(kind)
}

export function turnIdFromParams(params: any): string {
  return String(params?.turnId ?? params?.turn?.id ?? '')
}

export function sharedArtifactPath(workspaceId: string, sessionId: string, artifactId: string, name: string): string {
  return `shared://${workspaceId}/${sessionId}/${artifactId}/${name}`
}

export function isSharedArtifactPath(path?: string): boolean {
  return Boolean(path?.startsWith('shared://'))
}

function artifactLookupName(path?: string): string {
  return basename(String(path ?? '')).trim().toLowerCase()
}

export function findSharedWorkspaceFileForPath(files: WorkspaceFile[], path?: string): WorkspaceFile | null {
  const rawPath = String(path ?? '').trim()
  if (!rawPath) return null
  const sharedFiles = files.filter((file) => file.sharedArtifact)
  const exact = sharedFiles.find((file) => file.path === rawPath)
  if (exact) return exact

  const name = artifactLookupName(rawPath)
  if (!name) return null
  return sharedFiles.find((file) => artifactLookupName(file.name) === name || artifactLookupName(file.path) === name) ?? null
}

export function sharedArtifactFile(workspaceId: string, sessionId: string, artifact: SharedArtifact): WorkspaceFile {
  const createdAt = artifact.created_at ? Date.parse(artifact.created_at) : Date.now()
  return {
    id: `shared-${artifact.id}`,
    name: artifact.name,
    path: sharedArtifactPath(workspaceId, sessionId, artifact.id, artifact.name),
    source: 'change',
    status: 'created',
    detail: `Shared artifact${artifact.size_bytes ? ` (${fmtBytes(artifact.size_bytes)})` : ''}`,
    updatedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    sharedArtifact: {
      workspaceId,
      sessionId,
      artifactId: artifact.id,
      sizeBytes: artifact.size_bytes
    }
  }
}
