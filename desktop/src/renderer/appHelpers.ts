/**
 * Pure formatting helpers used by the renderer. No React, no IPC.
 * Every function here is testable in isolation.
 */
import type {
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

export function blocksFromSharedSnapshot(snapshot?: SharedSessionSnapshot | null): Block[] {
  const blocks = Array.isArray(snapshot?.blocks) ? snapshot.blocks : []
  return blocks.filter((block: any) => (
    block?.type === 'user' ||
    block?.type === 'agent' ||
    block?.type === 'files' ||
    block?.type === 'approval' ||
    block?.type === 'turn'
  ))
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
