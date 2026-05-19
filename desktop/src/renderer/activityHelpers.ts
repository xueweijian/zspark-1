/**
 * Activity-stream helpers: pure functions that classify codex `item/*`
 * messages into the renderer's Activity model, format their summaries,
 * and persist + replay them across reloads.
 */
import { detectMaskedCommandFailure } from './commandSafety'
import { shortPath } from './runtimeDisplay'
import type {
  Activity,
  ActivityActionKind,
  ActivityInfo,
  ActivityKind,
  Block,
  MemoryCitation,
  WorkspaceFile
} from './appTypes'
import {
  basename,
  describeChange
} from './appHelpers'

export const ACTIVITY_STORAGE_PREFIX = 'zspark:activity:v1:'
let fallbackReplayIdCounter = 0

function replayFallbackId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `replay-${uuid}`
  fallbackReplayIdCounter += 1
  return `replay-${Date.now().toString(36)}-${fallbackReplayIdCounter.toString(36)}`
}

export function activityStorageKey(threadId: string): string {
  return `${ACTIVITY_STORAGE_PREFIX}${threadId}`
}

export function activityDetailWeight(block?: Extract<Block, { type: 'turn' }>): number {
  if (!block) return 0
  return block.activities.reduce((total, activity) => total + (activity.detail?.length ?? 0), 0)
}

export function inferActionKindFromTitle(title?: string): ActivityActionKind | undefined {
  const t = String(title ?? '').toLowerCase()
  if (!t) return undefined
  if (/\bread\b/.test(t)) return 'read'
  if (/\b(write|wrote|created|prepared|updated|changed|modified)\b/.test(t)) return 'write'
  if (/\b(search|searched)\b/.test(t)) return 'search'
  if (/\b(list|listed|inspect|explored)\b/.test(t)) return 'list'
  if (/\b(build|export|pptx|deck)\b/.test(t)) return 'build'
  if (/\b(verify|check)\b/.test(t)) return 'verify'
  if (/\bused\b/.test(t)) return 'tool'
  return undefined
}

export function truncateActivityDetail(detail?: string, limit = 1800): string | undefined {
  if (!detail) return undefined
  const trimmed = detail.trim()
  if (trimmed.length <= limit) return trimmed
  return `Output truncated to last ${limit} characters.\n\n${trimmed.slice(-limit)}`
}

export function normalizeActivity(activity: any): Activity | null {
  if (!activity || typeof activity.id !== 'string' || typeof activity.title !== 'string') return null
  const kind: ActivityKind =
    activity.kind === 'command' || activity.kind === 'file' || activity.kind === 'tool' || activity.kind === 'web' || activity.kind === 'memory'
      ? activity.kind
      : 'reasoning'
  const status: Activity['status'] =
    activity.status === 'failed' ? 'failed' :
    activity.status === 'running' ? 'running' : 'done'
  const startedAt = Number(activity.startedAt) || Date.now()
  const endedAt = activity.endedAt ? Number(activity.endedAt) : undefined
  return {
    id: activity.id,
    kind,
    title: activity.title,
    detail: truncateActivityDetail(activity.detail, kind === 'reasoning' ? 2400 : 1400),
    actionKind: activity.actionKind ?? inferActionKindFromTitle(activity.title),
    target: activity.target,
    status,
    startedAt,
    endedAt
  }
}

export function loadPersistedActivityBlocks(threadId: string): Extract<Block, { type: 'turn' }>[] {
  try {
    const raw = window.localStorage.getItem(activityStorageKey(threadId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((block: any) =>
        block?.type === 'turn' &&
        typeof block.turnId === 'string' &&
        Array.isArray(block.activities)
      )
      .map((block: any) => ({
        ...block,
        activities: block.activities
          .map(normalizeActivity)
          .filter((activity: Activity | null): activity is Activity => Boolean(activity))
      }))
  } catch {
    return []
  }
}

export function serializePersistedActivityBlocks(blocks: Block[]): string | null {
  const turnBlocks = blocks.filter((block): block is Extract<Block, { type: 'turn' }> => block.type === 'turn')
  if (!turnBlocks.length) return null
  const normalized = turnBlocks.slice(-80).map((block) => ({
    ...block,
    activities: block.activities
      .map(normalizeActivity)
      .filter((activity: Activity | null): activity is Activity => Boolean(activity))
  }))
  return JSON.stringify(normalized)
}

export function savePersistedActivityBlocks(threadId: string, serialized: string): void {
  try {
    window.localStorage.setItem(activityStorageKey(threadId), serialized)
  } catch {
    // Best-effort UI continuity; chat correctness must not depend on storage.
  }
}

export function orderBlocksForTurn(blocks: Block[], turnId: string): Block[] {
  const groupedIndices = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) =>
      (block.type === 'user' && block.turnId === turnId) ||
      (block.type === 'turn' && block.turnId === turnId)
    )
    .map(({ index }) => index)
  if (groupedIndices.length < 2) return blocks

  const insertAt = Math.min(...groupedIndices)
  const users = blocks.filter((block) => block.type === 'user' && block.turnId === turnId)
  const turns = blocks.filter((block) => block.type === 'turn' && block.turnId === turnId)
  const rest = blocks.filter((block) =>
    !((block.type === 'user' && block.turnId === turnId) ||
      (block.type === 'turn' && block.turnId === turnId))
  )
  return [...rest.slice(0, insertAt), ...users, ...turns, ...rest.slice(insertAt)]
}

export function mergePersistedActivityBlocks(blocks: Block[], persisted: Extract<Block, { type: 'turn' }>[]): Block[] {
  if (!persisted.length) return blocks
  let next = [...blocks]
  for (const persistedTurn of persisted) {
    const existingIndex = next.findIndex((block) => block.type === 'turn' && block.turnId === persistedTurn.turnId)
    if (existingIndex !== -1) {
      const existing = next[existingIndex] as Extract<Block, { type: 'turn' }>
      if (activityDetailWeight(persistedTurn) > activityDetailWeight(existing) || existing.activities.length === 0) {
        next = next.map((block, index) => (
          index === existingIndex ? { ...persistedTurn, collapsed: false } : block
        ))
      }
      next = orderBlocksForTurn(next, persistedTurn.turnId)
      continue
    }

    const userIndex = next.findIndex((block) => block.type === 'user' && block.turnId === persistedTurn.turnId)
    if (userIndex === -1) continue
    next = [
      ...next.slice(0, userIndex + 1),
      { ...persistedTurn, collapsed: false },
      ...next.slice(userIndex + 1)
    ]
    next = orderBlocksForTurn(next, persistedTurn.turnId)
  }
  return next
}

export function shortenCommand(command: string, limit = 72): string {
  const firstLine = cleanShellCommand(command).split('\n')[0]?.trim() || command
  return firstLine.length > limit ? firstLine.slice(0, limit - 1) + '…' : firstLine
}

export function cleanShellCommand(command: string): string {
  return command
    .replace(/^\/bin\/(?:zsh|bash|sh) -lc\s+/, '')
    .replace(/^'([\s\S]*)'$/, '$1')
    .trim()
}

export interface DeletedArtifactReference {
  turnId: string
  pathKey: string
  nameKey: string
}

type ShellInvocationKind = 'cmd' | 'shell'

/**
 * Pull out paths the assistant deleted in this command. Prefer structured
 * delete actions when present, and parse command strings as a fallback for
 * shell output that only reports commands.
 */
export function extractDeletedPathsFromCommand(item: any): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const collect = (path: string) => {
    const text = path.trim().replace(/^['"]|['"]$/g, '')
    if (!text || seen.has(text)) return
    seen.add(text)
    out.push(text)
  }

  collectDeletedPathsFromCommand(String(item?.command ?? ''), collect)
  const actions = Array.isArray(item?.commandActions) ? item.commandActions : []
  for (const action of actions) {
    if (String(action?.type ?? '').toLowerCase() === 'delete' && action?.path) collect(String(action.path))
    if (action?.command) collectDeletedPathsFromCommand(String(action.command), collect)
  }
  return out
}

export function deletedArtifactReference(turnId: string, path: string): DeletedArtifactReference | null {
  const trimmed = path.trim()
  if (!turnId || !trimmed) return null
  return {
    turnId,
    pathKey: normalizeDeletedArtifactPath(trimmed),
    nameKey: deletedArtifactNameKey(trimmed)
  }
}

export function deletedArtifactReferenceMatchesCandidate(
  turnId: string,
  candidate: string,
  references: DeletedArtifactReference[]
): boolean {
  const trimmed = candidate.trim()
  if (!turnId || !trimmed) return false
  const pathKey = normalizeDeletedArtifactPath(trimmed)
  const nameKey = deletedArtifactNameKey(trimmed)
  const canUseBasenameFallback = !/[\\/]/.test(trimmed) && !/^[A-Za-z]:/.test(trimmed)
  return references.some((ref) => (
    ref.turnId === turnId &&
    (ref.pathKey === pathKey || (canUseBasenameFallback && ref.nameKey === nameKey))
  ))
}

function collectDeletedPathsFromCommand(
  command: string,
  collect: (path: string) => void,
  invocationKind: ShellInvocationKind = 'shell'
): void {
  if (!command) return
  const cleaned = cleanShellCommand(command)
  for (const segment of splitShellSegments(cleaned)) {
    const tokens = tokenizeShell(segment.trim())
    if (tokens.length === 0) continue
    const unwrapped = unwrapShellInvocation(tokens)
    if (unwrapped) {
      collectDeletedPathsFromCommand(unwrapped.command, collect, unwrapped.kind)
      continue
    }
    const verb = commandVerb(tokens[0])
    const kind = deleteVerbKind(verb, invocationKind)
    if (!kind) continue
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]
      if (!tok || shouldSkipDeleteToken(tok, kind)) continue
      collect(tok)
    }
  }
}

function tokenizeShell(line: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else buf += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (buf) { out.push(buf); buf = '' }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

function splitShellSegments(line: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      if ((ch === '&' || ch === '|') && line[i + 1] === ch) i++
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function commandVerb(token?: string): string {
  const raw = String(token ?? '').replace(/^['"]|['"]$/g, '')
  const parts = raw.split(/[\\/]/)
  return (parts.pop() || raw).toLowerCase()
}

function shellRemainder(tokens: string[], optionIndex: number): string {
  const rest = tokens.slice(optionIndex + 1)
  if (rest.length <= 1) return rest.join(' ')
  return rest.map((token) => /\s/.test(token) ? `"${token}"` : token).join(' ')
}

function unwrapShellInvocation(tokens: string[]): { command: string; kind: ShellInvocationKind } | null {
  const verb = commandVerb(tokens[0])
  if (verb === 'powershell.exe' || verb === 'powershell' || verb === 'pwsh.exe' || verb === 'pwsh') {
    const index = tokens.findIndex((token) => {
      const lower = token.toLowerCase()
      return lower === '-command' || lower === '-c'
    })
    return index === -1 ? null : { command: shellRemainder(tokens, index), kind: 'shell' }
  }
  if (verb === 'cmd.exe' || verb === 'cmd') {
    const index = tokens.findIndex((token) => {
      const lower = token.toLowerCase()
      return lower === '/c' || lower === '/k'
    })
    return index === -1 ? null : { command: shellRemainder(tokens, index), kind: 'cmd' }
  }
  if (verb === 'bash' || verb === 'sh' || verb === 'zsh') {
    const index = tokens.findIndex((token) => token === '-lc' || token === '-c')
    return index === -1 ? null : { command: shellRemainder(tokens, index), kind: 'shell' }
  }
  return null
}

function deleteVerbKind(verb: string, invocationKind: ShellInvocationKind): 'cmd' | 'shell' | null {
  if (verb === 'del' || verb === 'erase') return 'cmd'
  if (verb === 'rd' || verb === 'rmdir') return invocationKind === 'cmd' ? 'cmd' : 'shell'
  if (
    verb === 'rm' ||
    verb === 'unlink' ||
    verb === 'remove-item' ||
    verb === 'ri'
  ) return 'shell'
  return null
}

function shouldSkipDeleteToken(token: string, kind: 'cmd' | 'shell'): boolean {
  if (token === '--') return true
  if (token.startsWith('-')) return true
  if (kind === 'cmd' && /^\/[A-Za-z?]+$/.test(token)) return true
  return token === '>' || token === '2>' || token === '1>' || token === '>>'
}

function normalizeDeletedArtifactPath(path: string): string {
  return path.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
}

function deletedArtifactNameKey(path: string): string {
  return basename(normalizeDeletedArtifactPath(path)).toLowerCase()
}

export function titleizeToolName(value?: string): string {
  const raw = String(value ?? 'tool').split(':').pop() ?? 'tool'
  const lower = raw.toLowerCase()
  if (lower.includes('computer')) return 'Computer Use'
  if (lower.includes('read_mcp_resource')) return 'MCP resource'
  return raw
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function commandActionInfo(action: any): ActivityInfo | null {
  const actionType = String(action?.type ?? '')
  const target = action?.path ? String(action.path) : undefined
  const name = String(action?.name ?? (target ? basename(target) : '')).trim()
  const label = name || (target ? basename(target) : 'file')
  if (target && /\/presentations\/[^/]+\/skills\/presentations\/SKILL\.md$/.test(target)) {
    return { title: 'Loaded presentation skill', actionKind: 'read', target }
  }
  if (target && /\/skills\/(?:presentations|documents|spreadsheets)\//.test(target)) {
    return { title: 'Checked Office tooling', actionKind: 'read', target }
  }
  if (target && /\/slides\/slide[-_]\d+\.mjs$/i.test(target)) {
    return { title: `Drafted ${label.replace(/\.mjs$/i, '')}`, actionKind: 'write', target }
  }
  if (actionType === 'read') {
    return { title: `Read ${label}`, actionKind: 'read', target }
  }
  if (actionType === 'write' || actionType === 'update') {
    return { title: `Wrote ${label}`, actionKind: 'write', target }
  }
  if (actionType === 'delete') {
    return { title: `Deleted ${label}`, actionKind: 'write', target }
  }
  if (action?.command) return inferCommandInfo(String(action.command))
  return null
}

export function inferCommandInfo(command: string): ActivityInfo {
  const cleaned = cleanShellCommand(command)
  if (/build_artifact_deck\.mjs/.test(cleaned)) return { title: 'Built PPTX deck', actionKind: 'build' }
  if (/import\(['"]@oai\/artifact-tool['"]\)/.test(cleaned) || /artifact-tool ok/.test(cleaned)) return { title: 'Checked presentation runtime', actionKind: 'verify' }
  if (/\bmkdir\b/.test(cleaned)) return { title: 'Prepared workspace', actionKind: 'write' }
  if (/\btrash\b|\.Trash|~\/\.Trash|\bmv\b.+(?:Trash|\.Trash)/.test(cleaned)) return { title: 'Move files to Trash', actionKind: 'write' }
  if (/test -s|ls -lh/.test(cleaned)) return { title: 'Verified generated file', actionKind: 'verify' }
  if (/\b(rg|grep)\b/.test(cleaned)) return { title: 'Inspected project context', actionKind: 'search' }
  if (/\b(find|ls)\b/.test(cleaned)) return { title: 'Reviewed workspace files', actionKind: 'list' }
  if (/(cat\s+>|tee\s+|apply_patch)/.test(cleaned)) return { title: 'Drafted workspace content', actionKind: 'write' }
  if (/\b(cat|sed|head|tail)\b/.test(cleaned)) return { title: 'Read source material', actionKind: 'read' }
  if (/\bnpm\s+run\s+(typecheck|test|build)\b|\b(pnpm|yarn)\s+(test|build|typecheck)\b/.test(cleaned)) return { title: 'Ran quality checks', actionKind: 'run' }
  if (/\bgit\s+status\b/.test(cleaned)) return { title: 'Checked git status', actionKind: 'run' }
  if (/\bgit\s+commit\b/.test(cleaned)) return { title: 'Created git commit', detail: shortenCommand(cleaned, 96), actionKind: 'run' }
  if (/\bgit\s+push\b/.test(cleaned)) return { title: 'Pushed branch', detail: shortenCommand(cleaned, 96), actionKind: 'run' }
  return { title: 'Ran workspace step', actionKind: 'run' }
}

export function commandActivityInfo(item: any): ActivityInfo {
  const command = String(item?.command ?? '')
  const actions: ActivityInfo[] = Array.isArray(item?.commandActions)
    ? item.commandActions.map(commandActionInfo).filter((action: ActivityInfo | null): action is ActivityInfo => Boolean(action))
    : []
  if (actions.length === 1) return actions[0]
  if (actions.length > 1) {
    const firstKind = actions[0].actionKind
    const sameKind = actions.every((action) => action.actionKind === firstKind)
    if (sameKind && firstKind === 'read') return { title: `Read ${actions.length} files`, actionKind: 'read' }
    if (sameKind && firstKind === 'write') return { title: `Wrote ${actions.length} files`, actionKind: 'write' }
    return { title: `Ran ${actions.length} command actions`, detail: actions.map((action) => action.title).join('\n'), actionKind: 'run' }
  }
  return inferCommandInfo(command)
}

export function commandActivityDetail(item: any, info = commandActivityInfo(item)): string | undefined {
  const output = String(item?.aggregated_output ?? item?.aggregatedOutput ?? '').trim()
  const failure = detectMaskedCommandFailure(output)
  const actionDetail = info.detail || (info.target ? shortPath(info.target) : '')
  if (!output) return actionDetail || undefined
  if (failure) return failure.detail
  if (info.actionKind === 'read' && output.length > 800) {
    return actionDetail ? `${actionDetail}\nLarge read output hidden from the activity log.` : 'Large read output hidden from the activity log.'
  }
  const capped = truncateActivityDetail(output, info.actionKind === 'run' ? 1400 : 900)
  return actionDetail && capped ? `${actionDetail}\n\n${capped}` : capped
}

export function toolActivityInfo(item: any): ActivityInfo {
  const toolName = titleizeToolName(item?.tool ?? item?.name ?? item?.server)
  const detailParts: string[] = []
  if (item?.server) detailParts.push(`Server: ${item.server}`)
  if (item?.error?.message) detailParts.push(item.error.message)
  return {
    title: `Used ${toolName}`,
    detail: truncateActivityDetail(detailParts.join('\n'), 900),
    actionKind: 'tool'
  }
}

function collabAgentToolTitle(tool: string, status?: string): string {
  const running = status === 'inProgress'
  switch (tool) {
    case 'spawnAgent': return running ? 'Spawning agent' : 'Spawned agent'
    case 'sendInput': return running ? 'Messaging agent' : 'Messaged agent'
    case 'resumeAgent': return running ? 'Resuming agent' : 'Resumed agent'
    case 'wait': return running ? 'Waiting for agents' : 'Waited for agents'
    case 'closeAgent': return running ? 'Closing agent' : 'Closed agent'
    default: return `Used ${titleizeToolName(tool)}`
  }
}

export function collabAgentActivityStatus(item: any): Activity['status'] {
  if (item?.status === 'failed') return 'failed'
  if (item?.status === 'inProgress') return 'running'
  return 'done'
}

export function collabAgentActivityInfo(item: any): ActivityInfo {
  const tool = String(item?.tool ?? '')
  const detailParts: string[] = []
  const receiverThreadIds = Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds : []
  const agentStates = item?.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : null
  if (item?.model) detailParts.push(`Model: ${item.model}`)
  if (item?.reasoningEffort) detailParts.push(`Reasoning: ${item.reasoningEffort}`)
  if (receiverThreadIds.length) detailParts.push(`Agents: ${receiverThreadIds.length}`)
  if (agentStates) {
    const states = Object.entries(agentStates)
      .slice(0, 4)
      .map(([id, state]) => `${String(id).slice(0, 8)}: ${String((state as any)?.status ?? state)}`)
    if (states.length) detailParts.push(states.join('\n'))
  }
  const prompt = String(item?.prompt ?? '').trim()
  if (prompt) detailParts.push(`Prompt: ${prompt}`)
  return {
    title: collabAgentToolTitle(tool, item?.status),
    detail: truncateActivityDetail(detailParts.join('\n'), 900),
    actionKind: 'tool'
  }
}

export function webSearchActivityInfo(item: any): ActivityInfo {
  const query = String(item?.query ?? '').trim()
  return {
    title: query ? `Searched "${query}"` : 'Searched the web',
    detail: query || undefined,
    actionKind: 'search'
  }
}

export function actionKindForSummary(activity: Activity): ActivityActionKind | undefined {
  if (activity.actionKind) return activity.actionKind
  if (activity.kind === 'memory') return undefined
  if (activity.kind === 'tool') return 'tool'
  if (activity.kind === 'file') return 'file'
  if (activity.kind === 'web') return 'search'
  return inferActionKindFromTitle(activity.title)
}

export function activitySummaryLabels(activities: Activity[]): string[] {
  const visible = activities.filter((activity) => activity.kind !== 'reasoning')
  const counts = new Map<ActivityActionKind | 'command' | 'memory' | 'failed', number>()
  for (const activity of visible) {
    if (activity.status === 'failed') {
      counts.set('failed', (counts.get('failed') ?? 0) + 1)
      continue
    }
    if (activity.kind === 'command') counts.set('command', (counts.get('command') ?? 0) + 1)
    if (activity.kind === 'memory') counts.set('memory', (counts.get('memory') ?? 0) + 1)
    const actionKind = actionKindForSummary(activity)
    if (actionKind) counts.set(actionKind, (counts.get(actionKind) ?? 0) + 1)
  }
  const labels: string[] = []
  const plural = (count: number, singular: string, pluralLabel = `${singular}s`) => `${count} ${count === 1 ? singular : pluralLabel}`
  const push = (count: number | undefined, phrase: (count: number) => string) => {
    if (count) labels.push(phrase(count))
  }
  push(counts.get('failed'), (count) => `Blocked ${plural(count, 'step')}`)
  push(counts.get('command'), (count) => `Ran ${plural(count, 'command')}`)
  push(counts.get('tool'), (count) => `Used ${plural(count, 'tool')}`)
  push(counts.get('read'), (count) => `Read ${plural(count, 'file')}`)
  push(counts.get('write'), (count) => `Wrote ${plural(count, 'file action')}`)
  push(counts.get('search'), (count) => `Searched ${plural(count, 'time', 'times')}`)
  push(counts.get('list'), (count) => `Listed ${plural(count, 'folder')}`)
  push(counts.get('build'), (count) => `Built ${plural(count, 'artifact')}`)
  push(counts.get('verify'), (count) => `Verified ${plural(count, 'result')}`)
  push(counts.get('file'), (count) => `Changed ${plural(count, 'file')}`)
  push(counts.get('memory'), (count) => `Recorded ${plural(count, 'memory event')}`)
  return labels
}

export function publicActivityTitleText(value: string): string {
  const title = value.trim()
  if (/^Read SKILL\.md$/i.test(title)) return 'Loaded presentation skill'
  if (/^Read (?:build_artifact_deck|artifact_tool_utils|index)\.mjs$/i.test(title)) return 'Checked Office tooling'
  if (/^Read slide[-_]\d+\.mjs$/i.test(title)) return 'Reviewed slide source'
  if (/^Prepared workspace folders$/i.test(title)) return 'Prepared workspace'
  if (/^Wrote workspace files$/i.test(title)) return 'Drafted workspace content'
  if (/^Listed workspace files$/i.test(title)) return 'Reviewed workspace files'
  if (/^Read file content$/i.test(title)) return 'Read source material'
  if (/^Searched workspace$/i.test(title)) return 'Inspected project context'
  if (/^read_mcp_resource$/i.test(title)) return 'Used MCP resource'
  if (/^tool call$/i.test(title)) return 'Used tool'
  if (/^Ran \d+ command actions$/i.test(title)) return 'Ran workspace step'
  if (/^Ran (?:cd |node -e|["']?\/Users\/)/i.test(title)) return 'Ran workspace step'
  if (/\/Users\/|\.cache\/codex-runtimes|node_modules/.test(title)) return 'Ran workspace step'
  return title
}

export function publicActivityTitle(activity: Activity): string {
  return publicActivityTitleText(activity.title)
}

export function publicActivityDetail(activity: Activity): string | undefined {
  const detail = activity.detail?.trim()
  if (!detail) return undefined
  if (activity.kind === 'reasoning' || activity.kind === 'memory') return detail
  return undefined
}

export function displayActivities(activities: Activity[]): Array<Activity & { displayTitle: string; repeatCount: number }> {
  const visible: Array<Activity & { displayTitle: string; repeatCount: number }> = []
  for (const activity of activities) {
    const displayTitle = publicActivityTitle(activity)
    const previous = visible[visible.length - 1]
    if (
      previous &&
      previous.displayTitle === displayTitle &&
      previous.status === activity.status &&
      previous.kind === activity.kind
    ) {
      const existingDetail = previous.detail?.trim()
      const nextDetail = activity.detail?.trim()
      let detail = previous.detail
      if (nextDetail && !existingDetail) {
        detail = nextDetail
      } else if (nextDetail && existingDetail && !existingDetail.includes(nextDetail)) {
        detail = `${existingDetail}\n\n${nextDetail}`
      }
      visible[visible.length - 1] = {
        ...previous,
        repeatCount: previous.repeatCount + 1,
        endedAt: activity.endedAt ?? previous.endedAt,
        detail
      }
      continue
    }
    visible.push({ ...activity, displayTitle, repeatCount: 1 })
  }
  return visible
}

export function itemTimeMs(item: any, key: 'startedAtMs' | 'completedAtMs', fallback: number): number {
  return timestampToMs(item?.[key] ?? item?.[key.replace('Ms', '')], fallback)
}

export function timestampToMs(value: any, fallback = Date.now()): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n < 10000000000 ? n * 1000 : n
}

// Memory citation helpers (kept here because they are referenced by the
// reasoning/agent activity replay path below).
export function normalizeMemoryCitation(citation: any): MemoryCitation | null {
  if (!citation || typeof citation !== 'object') return null
  const entries = Array.isArray(citation.entries)
    ? citation.entries
        .map((entry: any) => {
          const path = String(entry?.path ?? '').trim()
          if (!path) return null
          return {
            path,
            lineStart: Number.isFinite(Number(entry?.lineStart)) ? Number(entry.lineStart) : undefined,
            lineEnd: Number.isFinite(Number(entry?.lineEnd)) ? Number(entry.lineEnd) : undefined,
            note: entry?.note ? String(entry.note) : undefined
          }
        })
        .filter((entry: any): entry is { path: string; lineStart?: number; lineEnd?: number; note?: string } => Boolean(entry))
    : []
  const threadIds = Array.isArray(citation.threadIds)
    ? citation.threadIds.map((id: any) => String(id)).filter(Boolean)
    : []
  if (!entries.length && !threadIds.length) return null
  return { entries, threadIds }
}

export function memoryCitationTitle(citation?: MemoryCitation | null): string {
  const count = citation?.entries?.length ?? 0
  if (count > 0) return `Referenced ${count} memor${count === 1 ? 'y' : 'ies'}`
  const threadCount = citation?.threadIds?.length ?? 0
  return threadCount > 0 ? `Used memory from ${threadCount} thread${threadCount === 1 ? '' : 's'}` : 'Referenced memory'
}

export function memoryCitationDetail(citation?: MemoryCitation | null): string | undefined {
  const entries = citation?.entries ?? []
  if (!entries.length) return undefined
  return entries.slice(0, 4).map((entry) => {
    const line = entry.lineStart ? `:${entry.lineStart}` : ''
    const note = entry.note ? ` — ${entry.note}` : ''
    return `${basename(entry.path)}${line}${note}`
  }).join('\n')
}

export function replayActivityFromItem(item: any, fallbackStartedAt: number): Activity | undefined {
  const id = String(item?.id ?? replayFallbackId())
  const startedAt = itemTimeMs(item, 'startedAtMs', fallbackStartedAt)
  const endedAt = itemTimeMs(item, 'completedAtMs', startedAt)
  if (item?.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : ''
    const content = Array.isArray(item.content) ? item.content.join('\n\n') : ''
    const detail = (summary + (summary && content ? '\n\n' : '') + content).trim()
    return { id: `replay-a-${id}`, kind: 'reasoning', title: 'Thought', detail: detail || undefined, status: 'done', startedAt, endedAt }
  }
  if (item?.type === 'commandExecution') {
    const status: Activity['status'] =
      item.status === 'failed' ? 'failed' :
      item.status === 'inProgress' ? 'running' : 'done'
    const info = commandActivityInfo(item)
    return {
      id: `replay-a-${id}`,
      kind: 'command',
      title: info.title,
      detail: commandActivityDetail(item, info),
      actionKind: info.actionKind,
      target: info.target,
      status,
      startedAt,
      endedAt: status === 'running' ? undefined : endedAt
    }
  }
  if (item?.type === 'fileChange') {
    const changes = item.changes ?? []
    return {
      id: `replay-a-${id}`,
      kind: 'file',
      title: `${changes.length} file${changes.length === 1 ? '' : 's'} changed`,
      detail: changes.map((change: any) => `${describeChange(change.kind)} ${change.path}`).join('\n'),
      actionKind: 'file',
      status: 'done',
      startedAt,
      endedAt
    }
  }
  if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall' || item?.type === 'collabAgentToolCall') {
    const info = item?.type === 'collabAgentToolCall' ? collabAgentActivityInfo(item) : toolActivityInfo(item)
    const status = item?.type === 'collabAgentToolCall'
      ? collabAgentActivityStatus(item)
      : item.status === 'failed' ? 'failed' : 'done'
    return {
      id: `replay-a-${id}`,
      kind: 'tool',
      title: info.title,
      detail: info.detail,
      actionKind: info.actionKind,
      status,
      startedAt,
      endedAt: status === 'running' ? undefined : endedAt
    }
  }
  if (item?.type === 'webSearch') {
    const info = webSearchActivityInfo(item)
    return {
      id: `replay-a-${id}`,
      kind: 'web',
      title: info.title,
      detail: info.detail,
      actionKind: info.actionKind,
      status: 'done',
      startedAt,
      endedAt
    }
  }
  if (item?.type === 'contextCompaction') {
    return {
      id: `replay-a-${id}`,
      kind: 'memory',
      title: 'Compacted context',
      detail: 'Earlier conversation context was summarized for future turns.',
      status: 'done',
      startedAt,
      endedAt
    }
  }
  return undefined
}

// Re-export here so files-from-changes consumers don't need a second import.
export type { WorkspaceFile }
