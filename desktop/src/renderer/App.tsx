import React, { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  IconNewChat, IconSearch, IconSkills, IconPlugins, IconAutomations,
  IconProject, IconSend, IconClose, IconSettings, IconChevron,
  IconBrain, IconTerminal, IconFile, IconImage, IconTool, IconGlobe,
  IconCopy, IconRegenerate, IconTrash, IconShield
} from './icons'
import {
  filterSkillCatalog,
  inferSkillCategory,
  recommendedSkillNamesForAttachment,
  skillCategoryOptions,
  suggestedPromptForAttachments,
  type SkillCategory
} from './skillCatalog'
import { normalizeMarkdownForDisplay } from './markdown'
import { dirname, extractArtifactPathCandidates, resolveWorkspacePath } from './artifacts'
import { formatApprovalPolicy, formatSandboxPolicy, shortPath } from './runtimeDisplay'
import { shouldSuppressServerWarning } from './serverWarnings'
import {
  commandFailureNotice,
  detectMaskedCommandFailure,
  type CommandFailureSignal
} from './commandSafety'
import {
  COMPLETED_WORK_FINALIZATION_TIMEOUT_MS,
  PROVIDER_RECONNECT_AUTO_INTERRUPT_MS,
  TURN_INTERRUPT_FALLBACK_RELEASE_MS,
  shouldRecoverFromCompletedWorkStall,
  shouldRecoverFromProviderRetry,
  type CompletedTurnWorkKind
} from './turnRecovery'

declare global {
  interface Window {
    zspark: {
      send: (line: string) => Promise<boolean>
      restart: () => Promise<boolean>
      pickAttachments: () => Promise<PickAttachmentsResult>
      getRuntimeInfo: () => Promise<RuntimeHostInfo>
      discoverLocalSkills: () => Promise<DiscoverLocalSkillsResult>
      openPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      downloadPath: (path: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      statPath: (path: string) => Promise<PathStatResult>
      openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
      scanRecentArtifacts: (options?: { sinceMs?: number; limit?: number }) => Promise<ArtifactScanResult>
      getSettings: () => Promise<{ provider?: { baseUrl: string; apiKey: string; model: string; wireApi: 'responses' | 'chat' } }>
      saveSettings: (s: any) => Promise<boolean>
      onStdout: (cb: (s: string) => void) => void | (() => void)
      onStderr: (cb: (s: string) => void) => void | (() => void)
      onExit: (cb: (code: number | null) => void) => void | (() => void)
      onSpawned: (cb: () => void) => void | (() => void)
    }
  }
}

const sidebarItems = [
  { label: 'New chat', Icon: IconNewChat },
  { label: 'Search', Icon: IconSearch },
  { label: 'Skills', Icon: IconSkills },
  { label: 'Plugins', Icon: IconPlugins },
  { label: 'Automations', Icon: IconAutomations }
]

const starters = [
  { t: 'Draft a status update', d: 'Summarize this week, write a Teams message.' },
  { t: 'Review a document', d: 'Open a file and surface the key risks.' },
  { t: 'Spin up a deck outline', d: 'Five-slide outline for an exec readout.' },
  { t: 'Automate a workflow', d: 'Schedule a recurring task from natural language.' }
]

const IGNORED_RPC_ERRORS = new Set(['Not initialized', 'Already initialized'])
const ACTIVITY_STORAGE_PREFIX = 'zspark:activity:v1:'
const USER_APPROVAL_REVIEWER = 'user'
const ZSPARK_APPROVAL_POLICY = 'on-request'

let nextId = 1
const newId = () => nextId++
interface Pending { resolve: (msg: any) => void; reject: (err: any) => void }
const pending = new Map<number, Pending>()
type JsonRpcId = number | string

function send(method: string, params: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const id = newId()
    pending.set(id, { resolve, reject })
    window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      .then((ok) => {
        if (!ok) {
          pending.delete(id)
          reject(new Error('Codex process is not running'))
        }
      })
      .catch((err) => {
        pending.delete(id)
        reject(err)
      })
  })
}

function sendRpcResult(id: JsonRpcId, result: any) {
  return window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function sendRpcError(id: JsonRpcId, code: number, message: string) {
  return window.zspark.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}

type ActivityKind = 'reasoning' | 'command' | 'file' | 'tool' | 'web' | 'memory'
type ActivityActionKind = 'read' | 'write' | 'list' | 'search' | 'run' | 'build' | 'verify' | 'tool' | 'file'
interface Activity {
  id: string
  kind: ActivityKind
  title: string
  detail?: string
  actionKind?: ActivityActionKind
  target?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}
type ActivityInfo = { title: string; detail?: string; actionKind: ActivityActionKind; target?: string }

type ApprovalKind = 'command' | 'fileChange' | 'permissions'
type ApprovalStatus = 'pending' | 'sending' | 'approved' | 'denied' | 'resolved'
interface ApprovalRequest {
  id: JsonRpcId
  key: string
  kind: ApprovalKind
  method: string
  blockId: string
  threadId: string
  turnId: string
  itemId: string
  title: string
  description: string
  detail?: string
  commandPreview?: string
  cwd?: string
  reason?: string
  paths: string[]
  params: any
  status: ApprovalStatus
  startedAt: number
}

interface MemoryCitationEntry {
  path: string
  lineStart?: number
  lineEnd?: number
  note?: string
}

interface MemoryCitation {
  entries?: MemoryCitationEntry[]
  threadIds?: string[]
}

type Block =
  | { type: 'user'; id: string; text: string; turnId?: string; input?: TurnInputItem[] }
  | { type: 'agent'; id: string; text: string; turnId?: string; memoryCitation?: MemoryCitation | null }
  | { type: 'files'; id: string; turnId: string; title: string; files: WorkspaceFile[]; subtitle?: string; tone?: 'normal' | 'warn' }
  | { type: 'approval'; id: string; turnId: string; request: ApprovalRequest }
  | { type: 'turn'; id: string; turnId: string; activities: Activity[]; collapsed: boolean; finalMessageId?: string; startedAt: number; endedAt?: number }
type MessageBlock = Extract<Block, { type: 'user' | 'agent' }>

type ToastKind = 'info' | 'warn' | 'error'
interface Toast { id: string; kind: ToastKind; text: string }

interface ProviderForm { baseUrl: string; apiKey: string; model: string; wireApi: 'responses' | 'chat' }

type Panel = null | 'search' | 'skills' | 'plugins' | 'automations' | 'history'

interface ThreadSummary { id: string; preview?: string; createdAt?: number; updatedAt?: number; name?: string | null }
interface SkillMeta {
  name: string
  description?: string
  shortDescription?: string
  displayName?: string
  path?: string
  scope?: string
  enabled?: boolean
  dependencies?: { tools?: Array<{ type?: string; value?: string; description?: string }> }
  availability?: 'usable' | 'localOnly'
  source?: string
}

type LocalSkillSource = 'workspace' | 'user' | 'system' | 'pluginCache'
interface LocalSkillMeta {
  name: string
  description?: string
  shortDescription?: string
  displayName?: string
  path: string
  source: LocalSkillSource
}

interface DiscoverLocalSkillsResult {
  skills: LocalSkillMeta[]
  errors: string[]
}

interface AttachmentMeta {
  id: string
  name: string
  path: string
  mime: string
  kind: 'image' | 'file'
  size: number
}

interface PickAttachmentsResult {
  attachments: Omit<AttachmentMeta, 'id'>[]
  errors: string[]
}

interface PathStatResult {
  exists: boolean
  isFile?: boolean
  isDirectory?: boolean
  size?: number
  mtimeMs?: number
  error?: string
}

interface ArtifactScanResult {
  root: string
  artifacts: Array<{
    name: string
    path: string
    size: number
    mtimeMs: number
  }>
}

interface RuntimeHostInfo {
  workspaceRoot: string
  attachmentDir: string
  codexRunning: boolean
  bridgePort: number | null
  provider?: { baseUrl: string; model: string; wireApi: 'responses' | 'chat' }
  workspaceRuntime?: WorkspaceRuntimeInfo
}

interface WorkspaceRuntimeInfo {
  nodePath: string
  nodeModulesPath: string
  pythonPath: string
  available: boolean
}

interface RuntimeInfo extends Partial<RuntimeHostInfo> {
  cwd?: string
  model?: string
  modelProvider?: string
  serviceTier?: string | null
  approvalPolicy?: unknown
  approvalsReviewer?: unknown
  sandbox?: unknown
  permissionProfile?: unknown
  activePermissionProfile?: { id?: string; modifications?: unknown[] } | null
  reasoningEffort?: string | null
}

function candidateWorkspacePaths(path: string, runtime: RuntimeInfo) {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return [path]
  const bases = [runtime.cwd, runtime.workspaceRoot].filter((base): base is string => Boolean(base))
  const seen = new Set<string>()
  const paths = bases.length ? bases.map((base) => resolveWorkspacePath(path, base)) : [path]
  return paths.filter((candidate) => {
    if (seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

interface WorkspaceFile {
  id: string
  name: string
  path: string
  source: 'attachment' | 'change'
  status: 'attached' | 'created' | 'modified' | 'deleted' | 'missing'
  detail?: string
  updatedAt: number
}

type TurnInputItem =
  | { type: 'text'; text: string; textElements?: any[]; text_elements?: any[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function stripInternalPromptContext(text: string) {
  const raw = String(text ?? '')
  const marker = raw.search(
    /(?:^|\n\s*\n)\s*(?:Use skill:|Attached file:|Attached image:|Zspark local runtime|Zspark execution safety:|Hard delivery contract:|Before using @oai\/artifact-tool|Before the final answer|For PPTX\/presentation tasks|The final response must|\[Skill:)/
  )
  return (marker === -1 ? raw : raw.slice(0, marker)).trim()
}

function displaySkillName(name?: string) {
  const raw = String(name ?? 'selected skill')
  return raw.split(':').pop() || raw
}

function displayThreadPreview(thread: ThreadSummary) {
  const label = stripInternalPromptContext(thread.preview?.trim() || thread.name || '')
  return label || thread.id.slice(0, 8)
}

function formatUserInputContent(content: any[]) {
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

function normalizeInputItemsForResubmit(content: any[]): TurnInputItem[] {
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

function scopeLabel(scope?: string) {
  switch (scope) {
    case 'repo': return 'Project'
    case 'user': return 'User'
    case 'system': return 'System'
    case 'admin': return 'Admin'
    default: return 'Skill'
  }
}

function localSkillSourceLabel(source?: string) {
  switch (source) {
    case 'workspace': return 'Project'
    case 'pluginCache': return 'Plugin cache'
    case 'system': return 'System'
    case 'user': return 'User'
    default: return source ?? 'Local'
  }
}

function skillStatusLabel(skill: SkillMeta) {
  if (skill.availability === 'localOnly') return 'Detected'
  if (skill.enabled === false) return 'Disabled'
  return 'Ready'
}

function skillStatusClass(skill: SkillMeta) {
  if (skill.availability === 'localOnly') return 'local'
  if (skill.enabled === false) return 'disabled'
  return 'ready'
}

function changeKindLabel(kind: any): WorkspaceFile['status'] {
  if (kind?.type === 'add' || kind === 'add') return 'created'
  if (kind?.type === 'delete' || kind === 'delete') return 'deleted'
  return 'modified'
}

function describeChange(kind: any) {
  if (kind?.type === 'update' && kind.movePath) return `Moved from ${kind.movePath}`
  return changeKindLabel(kind)
}

function turnIdFromParams(params: any) {
  return String(params?.turnId ?? params?.turn?.id ?? '')
}

marked.setOptions({ gfm: true, breaks: true })

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const normalized = normalizeMarkdownForDisplay(text || '')
    return DOMPurify.sanitize(marked.parse(normalized, { async: false }) as string)
  }, [text])
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element | null)?.closest?.('a[href]')
    const href = link?.getAttribute('href') ?? ''
    if (!/^(https?:|mailto:)/i.test(href)) return
    event.preventDefault()
    void window.zspark.openExternalUrl(href)
  }
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function artifactDownloadLabel(path: string) {
  const ext = basename(path).split('.').pop()?.toUpperCase()
  return ext ? `Download ${ext}` : 'Download'
}

function MessageArtifactButtons({
  candidates,
  runtime,
  onDownload,
  onOpen
}: {
  candidates: string[]
  runtime: RuntimeInfo
  onDownload: (path: string) => void
  onOpen: (path: string) => void
}) {
  const [artifacts, setArtifacts] = useState<Array<{ path: string; name: string }>>([])
  const candidatesKey = candidates.join('\n')
  const runtimeKey = `${runtime.cwd ?? ''}|${runtime.workspaceRoot ?? ''}`

  useEffect(() => {
    let cancelled = false
    const verify = async () => {
      const seen = new Set<string>()
      const verified: Array<{ path: string; name: string }> = []
      for (const candidate of candidates.slice(0, 8)) {
        for (const path of candidateWorkspacePaths(candidate, runtime)) {
          if (!path || seen.has(path)) continue
          seen.add(path)
          const stat = await window.zspark.statPath(path)
          if (!stat.exists || !stat.isFile) continue
          verified.push({ path, name: basename(path) })
          break
        }
        if (verified.length >= 4) break
      }
      if (!cancelled) setArtifacts(verified)
    }
    if (candidates.length === 0) {
      setArtifacts([])
      return
    }
    void verify()
    return () => { cancelled = true }
  }, [candidatesKey, runtimeKey])

  if (!artifacts.length) return null
  return (
    <div className="message-artifacts" aria-label="Detected files">
      {artifacts.map((artifact) => (
        <div className="message-artifact" key={artifact.path}>
          <div className="message-artifact-file" title={artifact.path}>
            <IconFile />
            <span>{artifact.name}</span>
          </div>
          <div className="message-artifact-actions">
            <button className="message-download" onClick={() => onDownload(artifact.path)}>{artifactDownloadLabel(artifact.path)}</button>
            <button onClick={() => onOpen(artifact.path)}>Open</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function MessageActions({
  onCopy,
  onDelete,
  onRegenerate,
  disabled,
  copyDisabled
}: {
  onCopy: () => void
  onDelete: () => void
  onRegenerate: () => void
  disabled?: boolean
  copyDisabled?: boolean
}) {
  return (
    <div className="message-actions" aria-label="Message actions">
      <button className="message-action" onClick={onCopy} disabled={copyDisabled} aria-label="Copy" title="Copy">
        <IconCopy />
      </button>
      <button className="message-action" onClick={onRegenerate} disabled={disabled} aria-label="Regenerate" title="Regenerate">
        <IconRegenerate />
      </button>
      <button className="message-action danger" onClick={onDelete} disabled={disabled} aria-label="Delete" title="Delete">
        <IconTrash />
      </button>
    </div>
  )
}

function normalizeMemoryCitation(citation: any): MemoryCitation | null {
  if (!citation || typeof citation !== 'object') return null
  const entries = Array.isArray(citation.entries)
    ? citation.entries
        .map((entry: any): MemoryCitationEntry | null => {
          const path = String(entry?.path ?? '').trim()
          if (!path) return null
          return {
            path,
            lineStart: Number.isFinite(Number(entry?.lineStart)) ? Number(entry.lineStart) : undefined,
            lineEnd: Number.isFinite(Number(entry?.lineEnd)) ? Number(entry.lineEnd) : undefined,
            note: entry?.note ? String(entry.note) : undefined
          }
        })
        .filter((entry: MemoryCitationEntry | null): entry is MemoryCitationEntry => Boolean(entry))
    : []
  const threadIds = Array.isArray(citation.threadIds)
    ? citation.threadIds.map((id: any) => String(id)).filter(Boolean)
    : []
  if (!entries.length && !threadIds.length) return null
  return { entries, threadIds }
}

function memoryCitationTitle(citation?: MemoryCitation | null) {
  const count = citation?.entries?.length ?? 0
  if (count > 0) return `Referenced ${count} memor${count === 1 ? 'y' : 'ies'}`
  const threadCount = citation?.threadIds?.length ?? 0
  return threadCount > 0 ? `Used memory from ${threadCount} thread${threadCount === 1 ? '' : 's'}` : 'Referenced memory'
}

function memoryCitationDetail(citation?: MemoryCitation | null) {
  const entries = citation?.entries ?? []
  if (!entries.length) return undefined
  return entries.slice(0, 4).map((entry) => {
    const line = entry.lineStart ? `:${entry.lineStart}` : ''
    const note = entry.note ? ` — ${entry.note}` : ''
    return `${basename(entry.path)}${line}${note}`
  }).join('\n')
}

function MemoryCitationPill({ citation }: { citation?: MemoryCitation | null }) {
  if (!citation) return null
  const detail = memoryCitationDetail(citation)
  return (
    <div className="memory-citation" title={detail}>
      <IconBrain />
      <span>{memoryCitationTitle(citation)}</span>
    </div>
  )
}

function rpcKey(id: JsonRpcId) {
  return String(id)
}

function userApprovalParams() {
  return { approvalPolicy: ZSPARK_APPROVAL_POLICY, approvalsReviewer: USER_APPROVAL_REVIEWER }
}

function isApprovalRequest(method: string) {
  return method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
}

function approvalKindForMethod(method: string): ApprovalKind | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': return 'command'
    case 'execCommandApproval': return 'command'
    case 'item/fileChange/requestApproval': return 'fileChange'
    case 'applyPatchApproval': return 'fileChange'
    case 'item/permissions/requestApproval': return 'permissions'
    default: return null
  }
}

function approvalStatusLabel(status: ApprovalStatus) {
  switch (status) {
    case 'pending': return 'Needs approval'
    case 'sending': return 'Sending decision'
    case 'approved': return 'Approved'
    case 'denied': return 'Denied'
    case 'resolved': return 'No longer needed'
  }
}

function approvalDecision(params: any, approved: boolean) {
  if (!approved) {
    const decisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : []
    return decisions.includes('decline') ? 'decline' : decisions.includes('cancel') ? 'cancel' : 'decline'
  }
  const decisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions : []
  if (decisions.includes('accept')) return 'accept'
  if (decisions.includes('acceptForSession')) return 'acceptForSession'
  return 'accept'
}

function uniqueCompact(values: Array<string | undefined | null>) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function pathsFromCommandActions(actions: any[] | null | undefined) {
  if (!Array.isArray(actions)) return []
  return uniqueCompact(actions.map((action) => action?.path))
}

function permissionPaths(permissions: any) {
  const fs = permissions?.fileSystem
  const entryPaths = Array.isArray(fs?.entries)
    ? fs.entries.map((entry: any) => entry?.path ?? entry?.root)
    : []
  return uniqueCompact([
    ...(Array.isArray(fs?.read) ? fs.read : []),
    ...(Array.isArray(fs?.write) ? fs.write : []),
    ...entryPaths
  ])
}

function permissionSummary(permissions: any) {
  const parts: string[] = []
  const paths = permissionPaths(permissions)
  if (paths.length) parts.push(`${paths.length} filesystem path${paths.length === 1 ? '' : 's'}`)
  if (permissions?.network?.enabled) parts.push('network access')
  return parts.length ? parts.join(' and ') : 'extra access'
}

function grantedPermissionsFromRequest(permissions: any) {
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

function approvalRequestFromServer(id: JsonRpcId, method: string, params: any): ApprovalRequest | null {
  const kind = approvalKindForMethod(method)
  if (!kind) return null
  const key = rpcKey(id)
  const turnId = String(params?.turnId ?? '')
  const threadId = String(params?.threadId ?? params?.conversationId ?? '')
  const itemId = String(params?.itemId ?? params?.callId ?? key)
  const cwd = params?.cwd ? String(params.cwd) : undefined
  const reason = params?.reason ? String(params.reason) : undefined
  const startedAt = timestampToMs(params?.startedAtMs, Date.now())

  if (kind === 'command') {
    const rawCommand = Array.isArray(params?.command) ? params.command.join(' ') : params?.command
    const info = commandActivityInfo({ command: rawCommand, commandActions: params?.commandActions })
    const command = rawCommand ? cleanShellCommand(String(rawCommand)) : undefined
    const paths = pathsFromCommandActions(params?.commandActions)
    return {
      id, key, kind, method, threadId, turnId, itemId,
      blockId: `approval-${key}`,
      title: publicActivityTitleText(info.title),
      description: params?.networkApprovalContext
        ? 'Codex needs network permission before continuing this step.'
        : 'Codex needs your approval before running this action outside the current sandbox.',
      detail: paths.length ? `${paths.length} related path${paths.length === 1 ? '' : 's'}` : undefined,
      commandPreview: command ? shortenCommand(command, 120) : undefined,
      cwd,
      reason,
      paths,
      params,
      status: 'pending',
      startedAt
    }
  }

  if (kind === 'fileChange') {
    const grantRoot = params?.grantRoot ? String(params.grantRoot) : undefined
    const changedPaths = params?.fileChanges && typeof params.fileChanges === 'object'
      ? Object.keys(params.fileChanges)
      : []
    return {
      id, key, kind, method, threadId, turnId, itemId,
      blockId: `approval-${key}`,
      title: 'Allow file changes',
      description: 'Codex wants to apply file changes and needs your approval.',
      detail: grantRoot ? `Requested write root: ${shortPath(grantRoot)}` : undefined,
      cwd,
      reason,
      paths: uniqueCompact([grantRoot, ...changedPaths]),
      params,
      status: 'pending',
      startedAt
    }
  }

  const paths = permissionPaths(params?.permissions)
  return {
    id, key, kind, method, threadId, turnId, itemId,
    blockId: `approval-${key}`,
    title: 'Grant extra access',
    description: `Codex is asking for ${permissionSummary(params?.permissions)}.`,
    detail: paths.length ? paths.map(shortPath).join('\n') : undefined,
    cwd,
    reason,
    paths,
    params,
    status: 'pending',
    startedAt
  }
}

function approvalResponsePayload(request: ApprovalRequest, approved: boolean) {
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return { decision: approved ? 'approved' : 'denied' }
  }
  if (request.kind === 'permissions') {
    return approved
      ? { scope: 'turn', permissions: grantedPermissionsFromRequest(request.params?.permissions) }
      : { scope: 'turn', permissions: {} }
  }
  return { decision: approvalDecision(request.params, approved) }
}

function ApprovalCard({
  request,
  onDecision
}: {
  request: ApprovalRequest
  onDecision: (request: ApprovalRequest, approved: boolean) => void
}) {
  const actionable = request.status === 'pending'
  return (
    <div className={`approval-card approval-${request.status}`}>
      <div className="approval-mark"><IconShield /></div>
      <div className="approval-content">
        <div className="approval-topline">
          <span>Approval required</span>
          <em>{approvalStatusLabel(request.status)}</em>
        </div>
        <div className="approval-title">{request.title}</div>
        <div className="approval-desc">{request.description}</div>
        {(request.reason || request.cwd || request.detail || request.commandPreview || request.paths.length > 0) && (
          <div className="approval-meta">
            {request.reason && <div><strong>Reason</strong><span>{request.reason}</span></div>}
            {request.cwd && <div><strong>Working folder</strong><span title={request.cwd}>{shortPath(request.cwd)}</span></div>}
            {request.detail && <div><strong>Details</strong><span>{request.detail}</span></div>}
            {request.paths.slice(0, 4).map((path) => (
              <div key={path}><strong>Path</strong><span title={path}>{shortPath(path)}</span></div>
            ))}
            {request.commandPreview && <div className="approval-command"><strong>Command</strong><span>{request.commandPreview}</span></div>}
          </div>
        )}
        <div className="approval-actions">
          <button className="approval-approve" disabled={!actionable} onClick={() => onDecision(request, true)}>Approve</button>
          <button className="approval-deny" disabled={!actionable} onClick={() => onDecision(request, false)}>Deny</button>
        </div>
      </div>
    </div>
  )
}

function filesFromChanges(changes: any[], base?: string, now = Date.now()): WorkspaceFile[] {
  return changes.map((change, index) => {
    const fullPath = resolveWorkspacePath(String(change.path ?? ''), base)
    const status = changeKindLabel(change.kind)
    return {
      id: `chg-${now}-${index}`,
      name: basename(fullPath),
      path: fullPath,
      source: 'change' as const,
      status,
      detail: describeChange(change.kind),
      updatedAt: now
    }
  }).filter((file) => file.path)
}

function officeRuntimeContext(skills: SkillMeta[], runtime: RuntimeInfo): string[] {
  if (!skills.some((skill) => inferSkillCategory(skill) === 'office')) return []
  const rt = runtime.workspaceRuntime
  if (!rt?.available) {
    return [
      'Selected Office skill requirement: produce an actual editable artifact file in the workspace. Do not answer with only a specification unless a runtime/setup blocker is real and explicitly observed.'
    ]
  }

  const presentationSkill = skills.find((skill) => {
    const text = `${skill.name} ${skill.displayName ?? ''} ${skill.path ?? ''}`
    return /\b(presentation|presentations|pptx?|powerpoint|slides?)\b/i.test(text)
  })
  const presentationSkillDir = dirname(presentationSkill?.path)
  const lines = [
    'Zspark local runtime for the selected Office skill:',
    `- Node.js executable: ${rt.nodePath}`,
    `- Node.js packages: ${rt.nodeModulesPath}`,
    `- Python executable: ${rt.pythonPath}`,
    'Use these bundled dependencies for documents, spreadsheets, and presentations.',
    'Hard delivery contract: create an actual editable artifact file in the workspace. A prose specification is a failure unless a real command fails and you report that command error.',
    'Before using @oai/artifact-tool from an output work directory, run this preflight pattern:',
    `  mkdir -p "$WORKSPACE" && cd "$WORKSPACE" && ln -sfn "${rt.nodeModulesPath}" node_modules`,
    `  "${rt.nodePath}" -e "import('@oai/artifact-tool').then(() => console.log('artifact-tool ok'))"`,
    'Before the final answer, verify the delivered file with `test -s "$FINAL_ARTIFACT" && ls -lh "$FINAL_ARTIFACT"`. Do not claim success or report a final path until that command succeeds.'
  ]
  if (presentationSkillDir) {
    lines.push(
      'For PPTX/presentation tasks, use the installed Presentations scripts instead of hand-waving:',
      `- SKILL_DIR: ${presentationSkillDir}`,
      `- Build/export helper: "${rt.nodePath}" "${presentationSkillDir}/scripts/build_artifact_deck.mjs" --slides-dir "$SLIDES_DIR" --out "$FINAL_PPTX" --preview-dir "$PREVIEW_DIR" --layout-dir "$LAYOUT_DIR"`,
      'Artifact-tool compose rules: write plain ESM slide modules, not raw JSX/HTML; `panel` accepts one child; use `row`/`column` with array children; `justify` values are start, center, end, or stretch.',
      'If the build helper fails, patch the slide source and rerun it until `test -s "$FINAL_PPTX"` passes.',
      'The final response must include only a PPTX path that exists after the verification command.'
    )
  }
  return [
    lines.join('\n')
  ]
}

function executionSafetyContext(prompt: string): string[] {
  const lower = prompt.toLowerCase()
  const mutatesFiles = /删除|删掉|移到|移动|放到|trash|废纸篓|delete|remove|move|rename|rm\b|mv\b/.test(lower)
  const targetsExternalPath = /桌面|desktop|downloads|documents|\/users\/|~\/|trash|废纸篓/.test(lower)
  if (!mutatesFiles || !targetsExternalPath) return []
  return [
    [
      'Zspark execution safety:',
      '- Do not claim that a file operation completed until command output and a follow-up check prove it.',
      '- For deleting, moving, trashing, or writing files outside the workspace, call exec_command with sandbox_permissions set to require_escalated and provide a concise justification so Zspark can show Approve/Deny.',
      '- Use command forms that fail on permission errors; do not mask failures with a later success-looking echo.'
    ].join('\n')
  ]
}

function blocksFromThreadTurns(turns: any[], base?: string): { blocks: Block[]; files: WorkspaceFile[] } {
  const blocks: Block[] = []
  const files: WorkspaceFile[] = []

  for (const turn of turns) {
    const userBlocks: Block[] = []
    const agentBlocks: Block[] = []
    const trailingBlocks: Block[] = []
    const turnId = String(turn?.id ?? `replay-turn-${blocks.length}`)
    const startedAt = timestampToMs(turn?.startedAt)
    let turnBlock: Extract<Block, { type: 'turn' }> | null = null
    const ensureTurnBlock = () => {
      if (!turnBlock) {
        turnBlock = {
          type: 'turn',
          id: `replay-turn-${turnId}`,
          turnId,
          activities: [],
          collapsed: false,
          startedAt,
          endedAt: turn?.completedAt ? timestampToMs(turn.completedAt) : undefined
        }
      }
      return turnBlock
    }
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (const item of items) {
      if (item?.type === 'userMessage') {
        const txt = formatUserInputContent(item.content ?? [])
        if (txt) userBlocks.push({ type: 'user', id: `replay-u-${item.id}`, text: txt, turnId, input: normalizeInputItemsForResubmit(item.content ?? []) })
      } else if (item?.type === 'reasoning' || item?.type === 'commandExecution' || item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall' || item?.type === 'webSearch' || item?.type === 'contextCompaction') {
        const activity = replayActivityFromItem(item, startedAt)
        if (activity) ensureTurnBlock().activities.push(activity)
      } else if (item?.type === 'agentMessage') {
        const txt = item.text ?? ''
        const memoryCitation = normalizeMemoryCitation(item.memoryCitation)
        if (memoryCitation) {
          ensureTurnBlock().activities.push({
            id: `replay-memory-${item.id}`,
            kind: 'memory',
            title: memoryCitationTitle(memoryCitation),
            detail: memoryCitationDetail(memoryCitation),
            status: 'done',
            startedAt,
            endedAt: itemTimeMs(item, 'completedAtMs', startedAt)
          })
        }
        if (txt) agentBlocks.push({ type: 'agent', id: `replay-a-${item.id}`, text: txt, turnId, memoryCitation })
      } else if (item?.type === 'fileChange') {
        const activity = replayActivityFromItem(item, startedAt)
        if (activity) ensureTurnBlock().activities.push(activity)
        const changed = filesFromChanges(item.changes ?? [], base, Date.now())
        if (changed.length) {
          files.push(...changed)
          trailingBlocks.push({
            type: 'files',
            id: `replay-files-${item.id}`,
            turnId: String(turn?.id ?? ''),
            title: `${changed.length} file${changed.length === 1 ? '' : 's'} ready`,
            files: changed
          })
        }
      }
    }
    const replayTurnBlock = turnBlock as Extract<Block, { type: 'turn' }> | null
    if (replayTurnBlock && !replayTurnBlock.endedAt && replayTurnBlock.activities.every((a) => a.status !== 'running')) {
      replayTurnBlock.endedAt = Math.max(...replayTurnBlock.activities.map((a) => a.endedAt ?? a.startedAt), startedAt)
    }
    blocks.push(...userBlocks)
    if (replayTurnBlock && replayTurnBlock.activities.length > 0) blocks.push(replayTurnBlock)
    blocks.push(...agentBlocks, ...trailingBlocks)
  }

  return { blocks, files }
}

function orderBlocksForTurn(blocks: Block[], turnId: string) {
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

function activityStorageKey(threadId: string) {
  return `${ACTIVITY_STORAGE_PREFIX}${threadId}`
}

function activityDetailWeight(block?: Extract<Block, { type: 'turn' }>) {
  if (!block) return 0
  return block.activities.reduce((total, activity) => total + (activity.detail?.length ?? 0), 0)
}

function inferActionKindFromTitle(title?: string): ActivityActionKind | undefined {
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

function truncateActivityDetail(detail?: string, limit = 1800) {
  if (!detail) return undefined
  const trimmed = detail.trim()
  if (trimmed.length <= limit) return trimmed
  return `Output truncated to last ${limit} characters.\n\n${trimmed.slice(-limit)}`
}

function normalizeActivity(activity: any): Activity | null {
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

function loadPersistedActivityBlocks(threadId: string): Extract<Block, { type: 'turn' }>[] {
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

function savePersistedActivityBlocks(threadId: string, blocks: Block[]) {
  const turnBlocks = blocks.filter((block): block is Extract<Block, { type: 'turn' }> => block.type === 'turn')
  if (!turnBlocks.length) return
  try {
    const normalized = turnBlocks.slice(-80).map((block) => ({
      ...block,
      activities: block.activities
        .map(normalizeActivity)
        .filter((activity: Activity | null): activity is Activity => Boolean(activity))
    }))
    window.localStorage.setItem(activityStorageKey(threadId), JSON.stringify(normalized))
  } catch {
    // Best-effort UI continuity; chat correctness must not depend on storage.
  }
}

function mergePersistedActivityBlocks(blocks: Block[], persisted: Extract<Block, { type: 'turn' }>[]) {
  if (!persisted.length) return blocks
  let next = [...blocks]
  for (const persistedTurn of persisted) {
    const existingIndex = next.findIndex((block) => block.type === 'turn' && block.turnId === persistedTurn.turnId)
    if (existingIndex !== -1) {
      const existing = next[existingIndex] as Extract<Block, { type: 'turn' }>
      if (activityDetailWeight(persistedTurn) > activityDetailWeight(existing) || existing.activities.length === 0) {
        next[existingIndex] = { ...persistedTurn, collapsed: false }
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

function shortenCommand(command: string, limit = 72) {
  const firstLine = cleanShellCommand(command).split('\n')[0]?.trim() || command
  return firstLine.length > limit ? firstLine.slice(0, limit - 1) + '…' : firstLine
}

function cleanShellCommand(command: string) {
  return command
    .replace(/^\/bin\/(?:zsh|bash|sh) -lc\s+/, '')
    .replace(/^'([\s\S]*)'$/, '$1')
    .trim()
}

function titleizeToolName(value?: string) {
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

function commandActionInfo(action: any): ActivityInfo | null {
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

function inferCommandInfo(command: string): ActivityInfo {
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

function commandActivityInfo(item: any): ActivityInfo {
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

function commandActivityDetail(item: any, info = commandActivityInfo(item)) {
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

function toolActivityInfo(item: any) {
  const toolName = titleizeToolName(item?.tool ?? item?.name ?? item?.server)
  const detailParts: string[] = []
  if (item?.server) detailParts.push(`Server: ${item.server}`)
  if (item?.error?.message) detailParts.push(item.error.message)
  return {
    title: `Used ${toolName}`,
    detail: truncateActivityDetail(detailParts.join('\n'), 900),
    actionKind: 'tool' as const
  }
}

function webSearchActivityInfo(item: any) {
  const query = String(item?.query ?? '').trim()
  return {
    title: query ? `Searched "${query}"` : 'Searched the web',
    detail: query || undefined,
    actionKind: 'search' as const
  }
}

function actionKindForSummary(activity: Activity): ActivityActionKind | undefined {
  if (activity.actionKind) return activity.actionKind
  if (activity.kind === 'memory') return undefined
  if (activity.kind === 'tool') return 'tool'
  if (activity.kind === 'file') return 'file'
  if (activity.kind === 'web') return 'search'
  return inferActionKindFromTitle(activity.title)
}

function activitySummaryLabels(activities: Activity[]) {
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

function publicActivityTitleText(value: string) {
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

function publicActivityTitle(activity: Activity) {
  return publicActivityTitleText(activity.title)
}

function publicActivityDetail(activity: Activity) {
  const detail = activity.detail?.trim()
  if (!detail) return undefined
  if (activity.kind === 'reasoning' || activity.kind === 'memory') return detail
  return undefined
}

function displayActivities(activities: Activity[]) {
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
      previous.repeatCount += 1
      previous.endedAt = activity.endedAt ?? previous.endedAt
      const existingDetail = previous.detail?.trim()
      const nextDetail = activity.detail?.trim()
      if (nextDetail && !existingDetail) {
        previous.detail = nextDetail
      } else if (nextDetail && existingDetail && !existingDetail.includes(nextDetail)) {
        previous.detail = `${existingDetail}\n\n${nextDetail}`
      }
      continue
    }
    visible.push({ ...activity, displayTitle, repeatCount: 1 })
  }
  return visible
}

function itemTimeMs(item: any, key: 'startedAtMs' | 'completedAtMs', fallback: number) {
  return timestampToMs(item?.[key] ?? item?.[key.replace('Ms', '')], fallback)
}

function timestampToMs(value: any, fallback = Date.now()) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n < 10000000000 ? n * 1000 : n
}

function replayActivityFromItem(item: any, fallbackStartedAt: number): Activity | undefined {
  const id = String(item?.id ?? `replay-${Math.random()}`)
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
  if (item?.type === 'mcpToolCall' || item?.type === 'dynamicToolCall') {
    const info = toolActivityInfo(item)
    return {
      id: `replay-a-${id}`,
      kind: 'tool',
      title: info.title,
      detail: info.detail,
      actionKind: info.actionKind,
      status: item.status === 'failed' ? 'failed' : 'done',
      startedAt,
      endedAt
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

function actIcon(k: ActivityKind) {
  switch (k) {
    case 'reasoning': return <IconBrain />
    case 'command': return <IconTerminal />
    case 'file': return <IconFile />
    case 'tool': return <IconTool />
    case 'web': return <IconGlobe />
    case 'memory': return <IconBrain />
  }
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<ProviderForm>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', wireApi: 'responses' })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    window.zspark.getSettings().then((s) => { if (s.provider) setForm((p) => ({ ...p, ...s.provider })) })
  }, [])
  const save = async () => {
    setSaving(true)
    await window.zspark.saveSettings({ provider: form })
    setSaving(false); onClose()
  }
  return (
    <div className="modal-bg">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Model provider</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <p className="modal-hint">Standard OpenAI-compatible endpoint. Talks via Responses API.</p>
        <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
        <label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
        <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
        <label>Wire API
          <select value={form.wireApi} onChange={(e) => setForm({ ...form, wireApi: e.target.value as any })}>
            <option value="responses">Responses API</option>
            <option value="chat">Chat Completions (via local bridge)</option>
          </select>
          <span className="modal-hint" style={{ marginTop: 4 }}>Chat Completions runs through zspark's in-process Chat↔Responses bridge — works with vLLM, SGLang, Ollama, AzureChatGPT, etc. Tool calls and reasoning_content are translated.</span>
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={saving || !form.apiKey || !form.baseUrl || !form.model}>{saving ? 'Saving…' : 'Save & restart'}</button>
        </div>
      </div>
    </div>
  )
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="drawer-bg">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="t">{title}</div>
          <button className="modal-x" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  )
}

function BridgeMissing() {
  return (
    <div className="bridge-missing">
      <div>
        <h1>Desktop bridge unavailable</h1>
        <p>zspark must run inside the Electron desktop shell. Reload the window if this appeared after a hot update.</p>
      </div>
    </div>
  )
}

export function App() {
  if (!window.zspark) return <BridgeMissing />
  return <DesktopApp />
}

function DesktopApp() {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [input, setInput] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [messageActionBusy, setMessageActionBusy] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [localSkills, setLocalSkills] = useState<LocalSkillMeta[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [skillCategory, setSkillCategory] = useState<SkillCategory>('work')
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [selectedSkills, setSelectedSkills] = useState<SkillMeta[]>([])
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([])
  const [runtime, setRuntime] = useState<RuntimeInfo>({})
  // Track current turn block id for incoming events
  const currentTurn = useRef<{ turnId: string; blockId: string; startedAt: number } | null>(null)
  // Map agent itemId (delta or completed) -> agent block id, scoped per turn
  const agentForTurn = useRef<Map<string, string>>(new Map())
  // Map item id -> activity id
  const itemActivity = useRef<Map<string, string>>(new Map())
  const approvalRequests = useRef<Map<string, ApprovalRequest>>(new Map())
  const seenTurnStarts = useRef<Set<string>>(new Set())
  const appliedReasoningCompletions = useRef<Set<string>>(new Set())
  const recentNotificationLines = useRef<Map<string, number>>(new Map())
  const restoredActivityThreads = useRef<Set<string>>(new Set())
  const checkedArtifactMessages = useRef<Map<string, string>>(new Map())
  const completedWorkByTurn = useRef<Map<string, Set<CompletedTurnWorkKind>>>(new Map())
  const commandFailuresByTurn = useRef<Map<string, CommandFailureSignal>>(new Map())
  const switchThreadSeq = useRef(0)
  const completedWorkStallTimers = useRef<Map<string, number>>(new Map())
  const providerRetryTimers = useRef<Map<string, number>>(new Map())
  const interruptFallbackTimers = useRef<Map<string, number>>(new Map())
  const interruptingTurns = useRef<Set<string>>(new Set())
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = useRef('')
  const runtimeRef = useRef<RuntimeInfo>({})
  const threadRef = useRef<string | null>(null)
  const shownArtifactPaths = useRef<Set<string>>(new Set())
  const submitInFlight = useRef(false)
  const stickToBottom = useRef(true)
  const programmaticScroll = useRef(false)

  const toast = (kind: ToastKind, text: string) => {
    const id = `t-${Date.now()}-${Math.random()}`
    setToasts((p) => [...p, { id, kind, text }])
    if (kind !== 'error') setTimeout(() => dismiss(id), 4000)
  }
  const dismiss = (id: string) => setToasts((p) => p.filter((t) => t.id !== id))
  const clearComposerText = () => {
    inputRef.current = ''
    if (taRef.current) {
      taRef.current.value = ''
      taRef.current.style.height = 'auto'
    }
    setInput('')
  }
  const updateStreamScrollState = () => {
    if (programmaticScroll.current) return
    const el = streamRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    stickToBottom.current = atBottom
    setShowJumpToLatest(!atBottom && blocks.length > 0)
  }
  const scrollToLatest = (behavior: ScrollBehavior = 'smooth') => {
    stickToBottom.current = true
    setShowJumpToLatest(false)
    programmaticScroll.current = true
    window.requestAnimationFrame(() => {
      const el = streamRef.current
      if (!el) {
        programmaticScroll.current = false
        return
      }
      el.scrollTo({ top: el.scrollHeight, behavior })
      window.setTimeout(() => {
        programmaticScroll.current = false
        updateStreamScrollState()
      }, behavior === 'smooth' ? 350 : 50)
    })
  }
  const pauseAutoScroll = () => {
    const el = streamRef.current
    if (!el || el.scrollHeight <= el.clientHeight) return
    stickToBottom.current = false
    setShowJumpToLatest(blocks.length > 0)
  }
  const handleStreamWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pauseAutoScroll()
  }
  const clearTurnRecoveryTimers = (turnId?: string) => {
    const clear = (timers: { current: Map<string, number> }) => {
      for (const [id, timer] of timers.current) {
        if (turnId && id !== turnId) continue
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
    }
    clear(completedWorkStallTimers)
    clear(providerRetryTimers)
    clear(interruptFallbackTimers)
  }
  const resetLiveTurnState = () => {
    clearTurnRecoveryTimers()
    currentTurn.current = null
    agentForTurn.current.clear()
    itemActivity.current.clear()
    approvalRequests.current.clear()
    seenTurnStarts.current.clear()
    appliedReasoningCompletions.current.clear()
    recentNotificationLines.current.clear()
    completedWorkByTurn.current.clear()
    commandFailuresByTurn.current.clear()
    interruptingTurns.current.clear()
  }
  const refreshRuntimeHost = async () => {
    try {
      const info = await window.zspark.getRuntimeInfo()
      setRuntime((prev) => ({ ...prev, ...info }))
    } catch {}
  }
  const applyThreadRuntime = (result: any) => {
    if (!result) return
    setRuntime((prev) => ({
      ...prev,
      cwd: result.cwd,
      model: result.model,
      modelProvider: result.modelProvider,
      serviceTier: result.serviceTier,
      approvalPolicy: result.approvalPolicy,
      approvalsReviewer: result.approvalsReviewer,
      sandbox: result.sandbox,
      permissionProfile: result.permissionProfile,
      activePermissionProfile: result.activePermissionProfile,
      reasoningEffort: result.reasoningEffort
    }))
  }
  const upsertWorkspaceFiles = (files: WorkspaceFile[]) => {
    setWorkspaceFiles((prev) => {
      const byPath = new Map(prev.map((file) => [file.path, file]))
      for (const file of files) byPath.set(file.path, { ...byPath.get(file.path), ...file })
      return [...byPath.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24)
    })
  }
  const upsertArtifactBlock = (
    turnId: string,
    itemId: string,
    files: WorkspaceFile[],
    options: { title?: string; subtitle?: string; tone?: 'normal' | 'warn' } = {}
  ) => {
    if (files.length === 0) return
    const id = `files-${itemId}`
    const title = options.title ?? `${files.length} file${files.length === 1 ? '' : 's'} ready`
    for (const file of files) {
      if (file.status !== 'missing') shownArtifactPaths.current.add(file.path)
    }
    setBlocks((bs) => {
      const next = { type: 'files' as const, id, turnId, title, files, subtitle: options.subtitle, tone: options.tone ?? 'normal' }
      if (bs.some((b) => b.id === id)) return bs.map((b) => (b.id === id ? next : b))
      return [...bs, next]
    })
  }

  const scanTurnArtifacts = async (turnId: string, startedAt: number, itemId: string) => {
    try {
      const result = await window.zspark.scanRecentArtifacts({
        sinceMs: Math.max(0, startedAt - 2000),
        limit: 12
      })
      const files: WorkspaceFile[] = result.artifacts
        .filter((artifact) => !shownArtifactPaths.current.has(artifact.path))
        .map((artifact, index) => ({
          id: `scan-${turnId}-${index}-${artifact.mtimeMs}`,
          name: artifact.name,
          path: artifact.path,
          source: 'change' as const,
          status: 'created' as const,
          detail: `Discovered under outputs/ (${fmtBytes(artifact.size)})`,
          updatedAt: artifact.mtimeMs
        }))
      if (!files.length) return
      upsertWorkspaceFiles(files)
      upsertArtifactBlock(turnId, itemId, files, {
        title: `${files.length} generated artifact${files.length === 1 ? '' : 's'} found`,
        subtitle: 'Discovered under outputs/ without a fileChange event'
      })
    } catch {
      // Artifact scanning is a best-effort UI fallback.
    }
  }

  const verifyArtifactClaims = async (turnId: string, itemId: string, text: string) => {
    const candidates = extractArtifactPathCandidates(text).slice(0, 8)
    if (!candidates.length) return

    const existing: WorkspaceFile[] = []
    const missing: WorkspaceFile[] = []
    const now = Date.now()
    await Promise.all(candidates.map(async (candidate, index) => {
      const paths = candidateWorkspacePaths(candidate, runtimeRef.current)
      let path = paths[0] ?? candidate
      let stat: PathStatResult = { exists: false }
      for (const possiblePath of paths) {
        const possibleStat = await window.zspark.statPath(possiblePath)
        if (possibleStat.exists && possibleStat.isFile) {
          path = possiblePath
          stat = possibleStat
          break
        }
        stat = possibleStat
      }
      const file: WorkspaceFile = {
        id: `claim-${now}-${index}`,
        name: basename(path),
        path,
        source: 'change',
        status: stat.exists && stat.isFile ? 'created' : 'missing',
        detail: stat.exists && stat.isFile
          ? `Verified from assistant output${stat.size ? ` (${fmtBytes(stat.size)})` : ''}`
          : 'Referenced by assistant output, but zspark could not find it on disk.',
        updatedAt: now
      }
      if (file.status === 'missing') missing.push(file)
      else existing.push(file)
    }))

    if (existing.length) {
      upsertWorkspaceFiles(existing)
      upsertArtifactBlock(turnId, `${itemId}-verified`, existing, {
        subtitle: 'Verified on disk from assistant output'
      })
    }
    if (missing.length) {
      upsertArtifactBlock(turnId, `${itemId}-missing`, missing, {
        title: 'Claimed artifact not found',
        subtitle: 'The assistant referenced this path, but zspark could not find it on disk.',
        tone: 'warn'
      })
      toast('error', `Artifact missing: ${missing.map((file) => file.name).join(', ')}`)
    }
  }

  const reconcileAgentArtifactClaims = async (agentBlock: Extract<Block, { type: 'agent' }>) => {
    const runtimeSignature = `${runtimeRef.current.cwd ?? ''}|${runtimeRef.current.workspaceRoot ?? ''}`
    const signature = `${runtimeSignature}|${agentBlock.text}`
    if (checkedArtifactMessages.current.get(agentBlock.id) === signature) return

    const candidates = extractArtifactPathCandidates(agentBlock.text).slice(0, 8)
    if (!candidates.length) return

    const files: WorkspaceFile[] = []
    const now = Date.now()
    for (const candidate of candidates) {
      for (const path of candidateWorkspacePaths(candidate, runtimeRef.current)) {
        const stat = await window.zspark.statPath(path)
        if (!stat.exists || !stat.isFile) continue
        files.push({
          id: `inline-${agentBlock.id}-${files.length}-${now}`,
          name: basename(path),
          path,
          source: 'change',
          status: 'created',
          detail: `Verified from assistant output${stat.size ? ` (${fmtBytes(stat.size)})` : ''}`,
          updatedAt: stat.mtimeMs ?? now
        })
        break
      }
    }

    if (!files.length) return
    checkedArtifactMessages.current.set(agentBlock.id, signature)
    upsertWorkspaceFiles(files)
    upsertArtifactBlock(agentBlock.turnId ?? `agent-${agentBlock.id}`, `${agentBlock.id}-inline-artifacts`, files, {
      title: `${files.length} downloadable artifact${files.length === 1 ? '' : 's'} ready`,
      subtitle: 'Verified from the assistant response'
    })
  }

  const updateTurn = (turnId: string, fn: (t: Extract<Block, { type: 'turn' }>) => Extract<Block, { type: 'turn' }>) => {
    setBlocks((bs) => bs.map((b) => (b.type === 'turn' && b.turnId === turnId ? fn(b) : b)))
  }
  const upsertTurnBlock = (turnId: string, blockId: string, startedAt: number) => {
    const thinkingId = `thinking-${turnId}`
    itemActivity.current.set(thinkingId, thinkingId)
    setBlocks((bs) => {
      const activity: Activity = { id: thinkingId, kind: 'reasoning', title: 'Thinking', status: 'running', startedAt }
      let found = false
      const next = bs.map((b) => {
        if (b.type !== 'turn' || b.turnId !== turnId) return b
        found = true
        const hasThinking = b.activities.some((a) => a.id === thinkingId)
        return {
          ...b,
          id: b.id || blockId,
          collapsed: false,
          endedAt: undefined,
          activities: hasThinking ? b.activities : [activity, ...b.activities]
        }
      })
      if (found) return orderBlocksForTurn(next, turnId)
      return orderBlocksForTurn([
        ...bs,
        {
          type: 'turn' as const,
          id: blockId,
          turnId,
          collapsed: false,
          startedAt,
          activities: [activity]
        }
      ], turnId)
    })
  }
  const upsertUserBlock = (turnId: string, itemId: string, text: string, input?: TurnInputItem[]) => {
    if (!text) return
    const id = `user-${itemId}`
    setBlocks((bs) => {
      let found = false
      const next = bs.map((b) => {
        if (b.id !== id || b.type !== 'user') return b
        found = true
        return { ...b, text, turnId, input }
      })
      if (found) return orderBlocksForTurn(next, turnId)
      const block: Block = { type: 'user', id, text, turnId, input }
      const turnIndex = bs.findIndex((b) => b.type === 'turn' && b.turnId === turnId)
      const withBlock = turnIndex === -1 ? [...bs, block] : [...bs.slice(0, turnIndex), block, ...bs.slice(turnIndex)]
      return orderBlocksForTurn(withBlock, turnId)
    })
  }
  const updateActivity = (turnId: string, actId: string, patch: Partial<Activity>) => {
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Activity>
    updateTurn(turnId, (t) => ({ ...t, activities: t.activities.map((a) => (a.id === actId ? { ...a, ...cleanPatch } : a)) }))
  }
  const ensureActivity = (turnId: string, itemId: string, init: Omit<Activity, 'id' | 'status' | 'startedAt'>) => {
    let actId = itemActivity.current.get(itemId)
    if (actId) return actId
    actId = itemId.startsWith('thinking-') ? itemId : `a-${itemId}`
    itemActivity.current.set(itemId, actId)
    updateTurn(turnId, (t) => {
      if (t.activities.some((a) => a.id === actId)) return t
      return { ...t, activities: [...t.activities, { id: actId!, status: 'running', startedAt: Date.now(), ...init }] }
    })
    return actId
  }
  const appendActivityDetail = (turnId: string, itemId: string, delta: string) => {
    const actId = itemActivity.current.get(itemId)
    if (!actId) return
    updateTurn(turnId, (t) => ({ ...t, activities: t.activities.map((a) => (a.id === actId ? { ...a, detail: (a.detail ?? '') + delta } : a)) }))
  }
  const appendAgentText = (turnId: string, blockId: string, delta: string) => {
    const failure = commandFailuresByTurn.current.get(turnId)
    if (failure) {
      const notice = commandFailureNotice(failure)
      setBlocks((bs) => {
        let found = false
        const next = bs.map((b) => {
          if (b.type !== 'agent' || b.id !== blockId) return b
          found = true
          return { ...b, text: notice, turnId }
        })
        return found ? next : [...bs, { type: 'agent' as const, id: blockId, text: notice, turnId }]
      })
      updateTurn(turnId, (t) => (t.finalMessageId ? t : { ...t, finalMessageId: blockId }))
      return
    }
    setBlocks((bs) => {
      let found = false
      const next = bs.map((b) => {
        if (b.type !== 'agent' || b.id !== blockId) return b
        found = true
        return { ...b, text: b.text + delta, turnId }
      })
      return found ? next : [...bs, { type: 'agent' as const, id: blockId, text: delta, turnId }]
    })
    // Also link the turn block to this agent block as its final message.
    updateTurn(turnId, (t) => (t.finalMessageId ? t : { ...t, finalMessageId: blockId }))
  }
  const recordCommandFailure = (turnId: string, failure: CommandFailureSignal) => {
    commandFailuresByTurn.current.set(turnId, failure)
    const notice = commandFailureNotice(failure)
    setBlocks((bs) => bs.map((b) => (
      b.type === 'agent' && b.turnId === turnId ? { ...b, text: notice } : b
    )))
  }
  const setApprovalStatus = (key: string, status: ApprovalStatus) => {
    const current = approvalRequests.current.get(key)
    if (current) approvalRequests.current.set(key, { ...current, status })
    setBlocks((bs) => bs.map((b) => (
      b.type === 'approval' && b.request.key === key
        ? { ...b, request: { ...b.request, status } }
        : b
    )))
  }
  const upsertApprovalBlock = (request: ApprovalRequest) => {
    approvalRequests.current.set(request.key, request)
    if (request.turnId) {
      upsertTurnBlock(request.turnId, `turn-${request.turnId}`, request.startedAt)
      const activityId = `approval-${request.key}`
      ensureActivity(request.turnId, activityId, {
        kind: 'tool',
        title: 'Waiting for approval',
        detail: request.title,
        actionKind: 'tool'
      })
    }
    setBlocks((bs) => {
      const existing = bs.findIndex((b) => b.type === 'approval' && b.request.key === request.key)
      const block: Block = { type: 'approval', id: request.blockId, turnId: request.turnId, request }
      if (existing !== -1) return bs.map((b, index) => (index === existing ? block : b))

      const turnIndex = bs.findIndex((b) => b.type === 'turn' && b.turnId === request.turnId)
      if (turnIndex !== -1) return [...bs.slice(0, turnIndex + 1), block, ...bs.slice(turnIndex + 1)]
      const userIndex = bs.findIndex((b) => b.type === 'user' && b.turnId === request.turnId)
      if (userIndex !== -1) return [...bs.slice(0, userIndex + 1), block, ...bs.slice(userIndex + 1)]
      return [...bs, block]
    })
  }
  const resolveApprovalRequest = (requestId: JsonRpcId) => {
    const key = rpcKey(requestId)
    const request = approvalRequests.current.get(key)
    if (!request || request.status === 'approved' || request.status === 'denied') return
    setApprovalStatus(key, 'resolved')
  }
  const handleServerRequest = (id: JsonRpcId, method: string, params: any) => {
    if (!isApprovalRequest(method)) {
      void sendRpcError(id, -32601, `Unsupported server request: ${method}`)
      toast('warn', `Unsupported server request: ${method}`)
      return
    }
    const request = approvalRequestFromServer(id, method, params)
    if (!request) {
      void sendRpcError(id, -32602, 'Malformed approval request')
      toast('error', 'Malformed approval request')
      return
    }
    if (!request.turnId && currentTurn.current) request.turnId = currentTurn.current.turnId
    upsertApprovalBlock(request)
    scrollToLatest('smooth')
  }
  const respondApproval = async (request: ApprovalRequest, approved: boolean) => {
    if (request.status !== 'pending') return
    setApprovalStatus(request.key, 'sending')
    try {
      const ok = await sendRpcResult(request.id, approvalResponsePayload(request, approved))
      if (!ok) throw new Error('Codex process is not running')
      setApprovalStatus(request.key, approved ? 'approved' : 'denied')
      if (request.turnId) {
        updateActivity(request.turnId, `a-approval-${request.key}`, {
          status: approved ? 'done' : 'failed',
          endedAt: Date.now(),
          title: approved ? 'Approval granted' : 'Approval denied',
          detail: request.title
        })
      }
    } catch (err: any) {
      setApprovalStatus(request.key, 'pending')
      toast('error', err?.message ?? String(err))
    }
  }

  const noteCompletedTurnWork = (turnId: string, kind: CompletedTurnWorkKind) => {
    if (!turnId) return
    const current = completedWorkByTurn.current.get(turnId) ?? new Set<CompletedTurnWorkKind>()
    current.add(kind)
    completedWorkByTurn.current.set(turnId, current)
    scheduleCompletedWorkFinalizationRecovery(turnId)
  }

  const settleTurnRecovery = (turnId: string) => {
    clearTurnRecoveryTimers(turnId)
    completedWorkByTurn.current.delete(turnId)
    interruptingTurns.current.delete(turnId)
  }

  const releaseTurnLocally = (turnId: string, detail: string) => {
    const active = currentTurn.current
    if (!active || active.turnId !== turnId) return
    submitInFlight.current = false
    setSubmitting(false)
    setStreaming(false)
    const providerRetryActivityId = itemActivity.current.get(`provider-retry-${turnId}`)
    updateTurn(turnId, (t) => ({
      ...t,
      endedAt: Date.now(),
      collapsed: false,
      activities: t.activities.map((a) => {
        if (a.id === providerRetryActivityId) {
          return {
            ...a,
            status: 'done' as const,
            endedAt: Date.now(),
            title: 'Provider reconnect stopped',
            detail: `${a.detail ?? ''}${detail}`.trim()
          }
        }
        if (a.status === 'running') return { ...a, status: 'done' as const, endedAt: Date.now() }
        return a
      })
    }))
    void scanTurnArtifacts(turnId, active.startedAt, `scan-${turnId}-released`)
    currentTurn.current = null
    settleTurnRecovery(turnId)
  }

  const interruptProviderRetryTurn = (
    turnId: string,
    detail = 'Completed work was already recorded; stopping the stalled final response.',
    title = 'Stopping stalled finalization'
  ) => {
    const active = currentTurn.current
    const currentThread = threadRef.current
    if (!active || active.turnId !== turnId || !currentThread || interruptingTurns.current.has(turnId)) return
    interruptingTurns.current.add(turnId)
    clearTurnRecoveryTimers(turnId)
    const itemId = `provider-retry-${turnId}`
    const actId = ensureActivity(turnId, itemId, {
      kind: 'tool',
      title,
      detail,
      actionKind: 'tool'
    })
    updateActivity(turnId, actId, {
      title,
      detail
    })
    const fallback = window.setTimeout(() => {
      releaseTurnLocally(turnId, '\nStop request is still pending; released the chat locally so the user can continue.')
      toast('warn', 'Provider reconnect was stuck; completed work was kept and the chat was released.')
    }, TURN_INTERRUPT_FALLBACK_RELEASE_MS)
    interruptFallbackTimers.current.set(turnId, fallback)
    void send('turn/interrupt', { threadId: currentThread, turnId })
      .then((result) => {
        if (result.error) throw new Error(result.error.message)
        if (currentTurn.current?.turnId === turnId) {
          releaseTurnLocally(turnId, '\nStopped stalled provider reconnect after completed work.')
        }
      })
      .catch((err: any) => {
        releaseTurnLocally(turnId, `\nStop request failed: ${err?.message ?? String(err)}`)
        toast('warn', 'Provider reconnect was stuck; completed work was kept and the chat was released.')
      })
  }

  const scheduleProviderRetryRecovery = (turnId: string) => {
    const completedWorkCount = completedWorkByTurn.current.get(turnId)?.size ?? 0
    if (!shouldRecoverFromProviderRetry({
      willRetry: true,
      completedWorkCount,
      alreadyInterrupting: interruptingTurns.current.has(turnId)
    })) return
    if (providerRetryTimers.current.has(turnId)) return
    const itemId = `provider-retry-${turnId}`
    const actId = ensureActivity(turnId, itemId, {
      kind: 'tool',
      title: 'Provider reconnecting',
      actionKind: 'tool'
    })
    updateActivity(turnId, actId, {
      title: 'Provider reconnecting'
    })
    appendActivityDetail(turnId, itemId, 'Provider is reconnecting after completed work. zspark will stop the stalled final response if it does not recover shortly.\n')
    const timer = window.setTimeout(() => {
      providerRetryTimers.current.delete(turnId)
      interruptProviderRetryTurn(
        turnId,
        'Completed work was already recorded; stopping the stalled final response.',
        'Stopping stalled reconnect'
      )
    }, PROVIDER_RECONNECT_AUTO_INTERRUPT_MS)
    providerRetryTimers.current.set(turnId, timer)
  }

  const scheduleCompletedWorkFinalizationRecovery = (turnId: string) => {
    const completedWorkCount = completedWorkByTurn.current.get(turnId)?.size ?? 0
    if (!shouldRecoverFromCompletedWorkStall({
      completedWorkCount,
      alreadyInterrupting: interruptingTurns.current.has(turnId)
    })) return
    if (completedWorkStallTimers.current.has(turnId)) return
    const timer = window.setTimeout(() => {
      completedWorkStallTimers.current.delete(turnId)
      interruptProviderRetryTurn(
        turnId,
        'Completed work was already recorded, but the provider did not finish the final response.'
      )
    }, COMPLETED_WORK_FINALIZATION_TIMEOUT_MS)
    completedWorkStallTimers.current.set(turnId, timer)
  }

  useEffect(() => { runtimeRef.current = runtime }, [runtime])
  useEffect(() => { threadRef.current = thread }, [thread])
  useEffect(() => { inputRef.current = input }, [input])
  useEffect(() => {
    if (streaming || submitting || !input.trim()) return
    const lastUser = [...blocks].reverse().find((b): b is Extract<Block, { type: 'user' }> => b.type === 'user')
    if (lastUser?.text.trim() === input.trim()) clearComposerText()
  }, [blocks])
  useEffect(() => { refreshRuntimeHost() }, [])

  useEffect(() => {
    function handle(method: string, params: any) {
      switch (method) {
        case 'turn/started': {
          submitInFlight.current = false
          setSubmitting(false)
          setStreaming(true)
          setClock(Date.now())
          stickToBottom.current = true
          setShowJumpToLatest(false)
          const turnId = turnIdFromParams(params)
          if (!turnId) return
          const blockId = `turn-${turnId}`
          const startedAt = Date.now()
          currentTurn.current = { turnId, blockId, startedAt }
          settleTurnRecovery(turnId)
          if (!seenTurnStarts.current.has(turnId)) {
            seenTurnStarts.current.add(turnId)
            agentForTurn.current.clear()
            itemActivity.current.clear()
            appliedReasoningCompletions.current.clear()
          }
          // Pre-create a Thinking activity so users see immediate feedback
          // even when the upstream model doesn't stream reasoning deltas.
          upsertTurnBlock(turnId, blockId, startedAt)
          return
        }
        case 'turn/completed': {
          submitInFlight.current = false
          setSubmitting(false)
          setStreaming(false)
          const turnId = turnIdFromParams(params)
          if (!turnId) return
          updateTurn(turnId, (t) => {
            // Mark any still-running activities done at end of turn (incl. our placeholder Thinking)
            const acts = t.activities.map((a) => (a.status === 'running' ? { ...a, status: 'done' as const, endedAt: Date.now(), title: a.kind === 'reasoning' ? 'Thought' : a.title } : a))
            return { ...t, endedAt: Date.now(), collapsed: false, activities: acts }
          })
          const startedAt = currentTurn.current?.turnId === turnId ? currentTurn.current.startedAt : Date.now()
          void scanTurnArtifacts(turnId, startedAt, `scan-${turnId}-completed`)
          currentTurn.current = null
          settleTurnRecovery(turnId)
          return
        }
        case 'thread/status/changed': {
          const eventThreadId = String(params?.threadId ?? '')
          if (eventThreadId && threadRef.current && eventThreadId !== threadRef.current) return
          const statusType = params?.status?.type
          if (!statusType || statusType === 'active') return
          const cur = currentTurn.current
          submitInFlight.current = false
          setSubmitting(false)
          setStreaming(false)
          if (cur) {
            updateTurn(cur.turnId, (t) => ({
              ...t,
              endedAt: Date.now(),
              activities: t.activities.map((a) => (
                a.status === 'running' ? { ...a, status: 'done' as const, endedAt: Date.now() } : a
              ))
            }))
            void scanTurnArtifacts(cur.turnId, cur.startedAt, `scan-${cur.turnId}-idle`)
            settleTurnRecovery(cur.turnId)
            currentTurn.current = null
          }
          return
        }
        case 'serverRequest/resolved': {
          if (params?.requestId !== undefined) resolveApprovalRequest(params.requestId)
          return
        }
        case 'thread/compacted': {
          const turnId = turnIdFromParams(params)
          if (!turnId) return
          const itemId = `context-compacted-${turnId}`
          upsertTurnBlock(turnId, `turn-${turnId}`, Date.now())
          const actId = ensureActivity(turnId, itemId, {
            kind: 'memory',
            title: 'Compacted context',
            detail: 'Earlier conversation context was summarized for future turns.'
          })
          updateActivity(turnId, actId, { status: 'done', endedAt: Date.now() })
          updateTurn(turnId, (t) => ({
            ...t,
            endedAt: t.endedAt ?? Date.now(),
            activities: t.activities.map((a) => (
              a.kind === 'reasoning' && a.status === 'running'
                ? { ...a, status: 'done' as const, endedAt: Date.now(), title: 'Context prepared' }
                : a
            ))
          }))
          return
        }
        case 'error':
        case 'warning': {
          // Codex pushes a top-level {"method":"error"} when the upstream
          // provider rejects the request body (e.g. vLLM choking on the
          // codex Responses API shape). Surface it instead of swallowing.
          if (method === 'warning') {
            const wm = params?.message ?? ''
            if (shouldSuppressServerWarning(wm)) return
            if (wm) toast('warn', wm)
            return
          }
          let msg = params?.error?.message ?? params?.message ?? 'Provider error'
          try { const inner = JSON.parse(msg); msg = inner?.error?.message ?? msg } catch {}
          if (params?.willRetry) {
            const cur = currentTurn.current
            if (cur) {
              const itemId = `provider-retry-${cur.turnId}`
              ensureActivity(cur.turnId, itemId, { kind: 'tool', title: 'Provider reconnecting', actionKind: 'tool' })
              appendActivityDetail(cur.turnId, itemId, `${msg}\n`)
              scheduleProviderRetryRecovery(cur.turnId)
            }
            return
          }
          submitInFlight.current = false
          setSubmitting(false)
          setStreaming(false)
          const cur = currentTurn.current
          if (cur) {
            updateTurn(cur.turnId, (t) => ({
              ...t,
              endedAt: Date.now(),
              activities: t.activities.map((a) => (
                a.status === 'running' ? { ...a, status: 'failed' as const, endedAt: Date.now() } : a
              ))
            }))
            settleTurnRecovery(cur.turnId)
            currentTurn.current = null
          }
          if (msg.length > 500) msg = msg.slice(0, 500) + '…'
          toast('error', msg)
          return
        }
        case 'item/agentMessage/delta': {
          const turnId = params.turnId as string
          const cur = currentTurn.current
          if (!cur || cur.turnId !== turnId) return
          let agentBlockId = agentForTurn.current.get(turnId)
          if (!agentBlockId) {
            agentBlockId = `agent-${turnId}`
            agentForTurn.current.set(turnId, agentBlockId)
            setBlocks((bs) => [...bs, { type: 'agent', id: agentBlockId!, text: '', turnId }])
          }
          appendAgentText(turnId, agentBlockId, params.delta ?? '')
          return
        }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          const turnId = params.turnId as string
          if (!currentTurn.current || currentTurn.current.turnId !== turnId) return
          // Route reasoning deltas into the placeholder Thinking activity so
          // we have one accumulator regardless of how many reasoning items
          // the model produces.
          const placeholderId = `thinking-${turnId}`
          if (!itemActivity.current.has(placeholderId)) {
            ensureActivity(turnId, placeholderId, { kind: 'reasoning', title: 'Thinking' })
          }
          appendActivityDetail(turnId, placeholderId, params.delta ?? '')
          return
        }
        case 'item/commandExecution/outputDelta': {
          const turnId = params.turnId as string
          if (!currentTurn.current || currentTurn.current.turnId !== turnId) return
          const itemId = String(params.itemId ?? '')
          if (!itemId) return
          if (!itemActivity.current.has(itemId)) {
            ensureActivity(turnId, itemId, { kind: 'command', title: 'Command output', actionKind: 'run' })
          }
          appendActivityDetail(turnId, itemId, params.delta ?? '')
          return
        }
        case 'item/started':
        case 'item/completed': {
          const item = params?.item
          if (!item) return
          const turnId = params.turnId as string
          if (item.type === 'userMessage') {
            if (method === 'item/started') {
              const txt = formatUserInputContent(item.content ?? [])
              if (inputRef.current.trim() === txt.trim()) clearComposerText()
              upsertUserBlock(turnId, String(item.id ?? `user-${turnId}`), txt, normalizeInputItemsForResubmit(item.content ?? []))
            }
            return
          }
          if (item.type === 'agentMessage' && method === 'item/completed') {
            // The completed event carries the authoritative full text. Some
            // providers stream only the first chunk via deltas (or send no
            // deltas at all) and put the rest in the final completed item.
            // Always overwrite the bubble with the canonical text.
            const failure = commandFailuresByTurn.current.get(turnId)
            const txt = failure
              ? commandFailureNotice(failure)
              : item.text ?? (Array.isArray(item.content) ? item.content.map((c: any) => c.text ?? '').join('') : '')
            if (!txt) return
            const memoryCitation = normalizeMemoryCitation(item.memoryCitation)
            const blockId = agentForTurn.current.get(turnId) ?? `agent-${turnId}-final`
            agentForTurn.current.set(turnId, blockId)
            setBlocks((bs) => {
              let found = false
              const next = bs.map((b) => {
                if (b.type !== 'agent' || b.id !== blockId) return b
                found = true
                return { ...b, text: txt, turnId, memoryCitation }
              })
              return found ? next : [...bs, { type: 'agent' as const, id: blockId, text: txt, turnId, memoryCitation }]
            })
            if (memoryCitation) {
              const memoryItemId = `memory-${String(item.id ?? blockId)}`
              const actId = ensureActivity(turnId, memoryItemId, {
                kind: 'memory',
                title: memoryCitationTitle(memoryCitation),
                detail: memoryCitationDetail(memoryCitation)
              })
              updateActivity(turnId, actId, { status: 'done', endedAt: Date.now() })
            }
            updateTurn(turnId, (t) => ({ ...t, finalMessageId: blockId }))
            void verifyArtifactClaims(turnId, String(item.id ?? `agent-${turnId}`), txt)
            const startedAt = currentTurn.current?.turnId === turnId ? currentTurn.current.startedAt : Date.now()
            window.setTimeout(() => void scanTurnArtifacts(turnId, startedAt, `scan-${String(item.id ?? `agent-${turnId}`)}`), 500)
            return
          }
          if (item.type === 'reasoning') {
            // If the upstream returned reasoning as a single completed item
            // (no deltas), append the summary/content to the placeholder.
            if (method === 'item/completed') {
              const completionKey = `${turnId}:${String(item.id ?? 'reasoning')}`
              if (appliedReasoningCompletions.current.has(completionKey)) return
              appliedReasoningCompletions.current.add(completionKey)
              const placeholderId = `thinking-${turnId}`
              const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : ''
              const content = Array.isArray(item.content) ? item.content.join('\n\n') : ''
              const txt = (summary + (summary && content ? '\n\n' : '') + content).trim()
              if (txt && !itemActivity.current.has(placeholderId)) {
                ensureActivity(turnId, placeholderId, { kind: 'reasoning', title: 'Thinking' })
              }
              if (txt) appendActivityDetail(turnId, placeholderId, txt)
            }
            return
          }
          if (item.type === 'contextCompaction') {
            const itemId = String(item.id ?? `context-compaction-${turnId}`)
            if (method === 'item/started') {
              ensureActivity(turnId, itemId, {
                kind: 'memory',
                title: 'Compacting context',
                detail: 'Summarizing earlier conversation context for future turns.'
              })
            } else {
              if (!itemActivity.current.has(itemId)) {
                ensureActivity(turnId, itemId, {
                  kind: 'memory',
                  title: 'Compacting context',
                  detail: 'Summarizing earlier conversation context for future turns.'
                })
              }
              updateActivity(turnId, itemActivity.current.get(itemId)!, {
                status: 'done',
                endedAt: Date.now(),
                title: 'Compacted context',
                detail: 'Earlier conversation context was summarized for future turns.'
              })
            }
            return
          }
          if (item.type === 'commandExecution') {
            const itemId = item.id as string
            const info = commandActivityInfo(item)
            if (method === 'item/started') {
              ensureActivity(turnId, itemId, { kind: 'command', title: info.title, detail: info.detail, actionKind: info.actionKind, target: info.target })
            } else {
              const output = String(item?.aggregated_output ?? item?.aggregatedOutput ?? '')
              const maskedFailure = detectMaskedCommandFailure(output)
              const status: Activity['status'] =
                maskedFailure ? 'failed' :
                item.status === 'completed' ? 'done' :
                item.status === 'failed' ? 'failed' : 'done'
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'command', title: info.title, actionKind: info.actionKind, target: info.target })
              updateActivity(turnId, itemActivity.current.get(itemId)!, {
                status, endedAt: Date.now(),
                detail: commandActivityDetail(item, info),
                title: maskedFailure?.title ?? info.title,
                actionKind: info.actionKind,
                target: info.target
              })
              if (maskedFailure) {
                recordCommandFailure(turnId, maskedFailure)
              }
              if (status === 'done') {
                noteCompletedTurnWork(turnId, 'command')
                const startedAt = currentTurn.current?.turnId === turnId ? currentTurn.current.startedAt : Date.now()
                window.setTimeout(() => void scanTurnArtifacts(turnId, startedAt, `scan-${itemId}-command`), 500)
              }
            }
            return
          }
          if (item.type === 'fileChange') {
            const itemId = item.id as string
            const changes = item.changes ?? []
            const title = `${changes.length} file${changes.length === 1 ? '' : 's'} changed`
            const detail = changes.map((change: any) => `${describeChange(change.kind)} ${change.path}`).join('\n')
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'file', title, actionKind: 'file' })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'file', title, actionKind: 'file' })
              const files = filesFromChanges(changes, runtimeRef.current.cwd ?? runtimeRef.current.workspaceRoot)
              upsertWorkspaceFiles(files)
              upsertArtifactBlock(turnId, itemId, files)
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: 'done', endedAt: Date.now(), title, detail, actionKind: 'file' })
              noteCompletedTurnWork(turnId, 'file')
            }
            return
          }
          if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
            const itemId = item.id as string
            const info = toolActivityInfo(item)
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'tool', title: info.title, detail: info.detail, actionKind: info.actionKind })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'tool', title: info.title, actionKind: info.actionKind })
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: item.status === 'failed' ? 'failed' : 'done', endedAt: Date.now(), title: info.title, detail: info.detail, actionKind: info.actionKind })
              if (item.status !== 'failed') noteCompletedTurnWork(turnId, 'tool')
            }
            return
          }
          if (item.type === 'webSearch') {
            const itemId = item.id as string
            const info = webSearchActivityInfo(item)
            if (method === 'item/started') ensureActivity(turnId, itemId, { kind: 'web', title: info.title, detail: info.detail, actionKind: info.actionKind })
            else {
              if (!itemActivity.current.has(itemId)) ensureActivity(turnId, itemId, { kind: 'web', title: info.title, actionKind: info.actionKind })
              updateActivity(turnId, itemActivity.current.get(itemId)!, { status: 'done', endedAt: Date.now(), title: info.title, detail: info.detail, actionKind: info.actionKind })
              noteCompletedTurnWork(turnId, 'web')
            }
            return
          }
          return
        }
        default: return
      }
    }

    const offStdout = window.zspark.onStdout((chunk) => {
      buf.current += chunk
      let nl: number
      while ((nl = buf.current.indexOf('\n')) !== -1) {
        const line = buf.current.slice(0, nl).trim()
        buf.current = buf.current.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method && msg.id !== undefined) {
            handleServerRequest(msg.id, msg.method, msg.params)
          } else if (typeof msg.id === 'number' && pending.has(msg.id)) {
            pending.get(msg.id)!.resolve(msg)
            pending.delete(msg.id)
            if (msg.error && !IGNORED_RPC_ERRORS.has(msg.error.message)) toast('error', msg.error.message)
          } else if (msg.method) {
            const now = Date.now()
            const previous = recentNotificationLines.current.get(line)
            if (previous && now - previous < 1000) continue
            recentNotificationLines.current.set(line, now)
            if (recentNotificationLines.current.size > 500) {
              for (const [key, seenAt] of recentNotificationLines.current) {
                if (now - seenAt > 5000) recentNotificationLines.current.delete(key)
              }
            }
            handle(msg.method, msg.params)
          }
        } catch { /* ignore */ }
      }
    })
    const offStderr = window.zspark.onStderr(() => {})
    const offExit = window.zspark.onExit(() => {
      submitInFlight.current = false
      setSubmitting(false)
      setReady(false)
      setStreaming(false)
      setThread(null)
      resetLiveTurnState()
      setRuntime((prev) => ({ ...prev, codexRunning: false }))
    })

    const handshake = async () => {
      try {
        const init = await send('initialize', { clientInfo: { name: 'zspark-desktop', version: '0.0.1' } })
        if (init.error && init.error.message !== 'Already initialized') { toast('error', init.error.message); return }
        const t = await send('thread/start', userApprovalParams())
        const tid = t.result?.thread?.id ?? null
        applyThreadRuntime(t.result)
        setThread(tid); setReady(true)
        refreshRuntimeHost()
      } catch (e: any) { toast('error', e?.message ?? String(e)) }
    }
    const offSpawned = window.zspark.onSpawned(() => {
      setRuntime((prev) => ({ ...prev, codexRunning: true }))
      refreshRuntimeHost()
      handshake()
    })
    handshake()
    return () => {
      if (typeof offStdout === 'function') offStdout()
      if (typeof offStderr === 'function') offStderr()
      if (typeof offExit === 'function') offExit()
      if (typeof offSpawned === 'function') offSpawned()
    }
  }, [])

  useEffect(() => {
    if (stickToBottom.current) scrollToLatest('auto')
    else setShowJumpToLatest(blocks.length > 0)
  }, [blocks])
  useEffect(() => {
    if (!thread || restoredActivityThreads.current.has(thread)) return
    const persisted = loadPersistedActivityBlocks(thread)
    restoredActivityThreads.current.add(thread)
    if (!persisted.length) return
    setBlocks((bs) => (bs.length ? mergePersistedActivityBlocks(bs, persisted) : bs))
  }, [thread])
  useEffect(() => {
    if (!thread) return
    savePersistedActivityBlocks(thread, blocks)
  }, [blocks, thread])
  useEffect(() => {
    for (const block of blocks) {
      if (block.type === 'agent') void reconcileAgentArtifactClaims(block)
    }
  }, [blocks, runtime.cwd, runtime.workspaceRoot])
  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])
  useEffect(() => {
    const ta = taRef.current; if (!ta) return
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  // Refresh thread list when ready, and on each turn boundary (start/end)
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const refresh = async () => {
      try {
        const r = await send('thread/list', { limit: 50 })
        if (!cancelled) setThreads(r.result?.data ?? [])
      } catch {}
    }
    refresh()
    return () => { cancelled = true }
  }, [ready, thread])

  useEffect(() => {
    if (!ready) return
    refreshSkills().catch(() => {})
  }, [ready])

  const newChat = async () => {
    if (!ready) return
    const seq = switchThreadSeq.current + 1
    switchThreadSeq.current = seq
    stickToBottom.current = true
    setShowJumpToLatest(false)
    resetLiveTurnState()
    setBlocks([])
    try {
      const t = await send('thread/start', userApprovalParams())
      if (seq !== switchThreadSeq.current) return
      applyThreadRuntime(t.result)
      setThread(t.result?.thread?.id ?? null)
    } catch (e: any) {
      if (seq === switchThreadSeq.current) toast('error', e?.message ?? String(e))
    }
  }
  const switchThread = async (id: string) => {
    if (!ready) return
    const seq = switchThreadSeq.current + 1
    switchThreadSeq.current = seq
    stickToBottom.current = true
    setShowJumpToLatest(false)
    resetLiveTurnState()
    setBlocks([])
    try {
      const t = await send('thread/resume', { threadId: id, ...userApprovalParams() })
      if (seq !== switchThreadSeq.current) return
      if (t.error) throw new Error(t.error.message)
      applyThreadRuntime(t.result)
      setThread(t.result?.thread?.id ?? id)
      setPanel(null)
      let threadForReplay = t.result?.thread
      if (!Array.isArray(threadForReplay?.turns) || threadForReplay.turns.length === 0) {
        const read = await send('thread/read', { threadId: id, includeTurns: true })
        if (seq !== switchThreadSeq.current) return
        if (read.error) throw new Error(read.error.message)
        threadForReplay = read.result?.thread ?? threadForReplay
      }
      if (seq !== switchThreadSeq.current) return
      const base = t.result?.cwd ?? threadForReplay?.cwd ?? runtimeRef.current.cwd ?? runtimeRef.current.workspaceRoot
      const replay = blocksFromThreadTurns(threadForReplay?.turns ?? [], base)
      const restoredBlocks = mergePersistedActivityBlocks(replay.blocks, loadPersistedActivityBlocks(id))
      if (replay.files.length) upsertWorkspaceFiles(replay.files)
      if (restoredBlocks.length) setBlocks(restoredBlocks)
      else {
        const preview = stripInternalPromptContext(threads.find((candidate) => candidate.id === id)?.preview?.trim() ?? '')
        if (preview) setBlocks([{ type: 'user', id: `preview-${id}`, text: preview }])
      }
    } catch (e: any) {
      if (seq === switchThreadSeq.current) toast('error', e?.message ?? String(e))
    }
  }
  const deleteThread = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!ready) return
    if (!confirm('Delete this chat? This cannot be undone.')) return
    try {
      // codex archives via thread/archive (soft-delete from list view)
      await send('thread/archive', { threadId: id })
      setThreads((p) => p.filter((t) => t.id !== id))
      if (thread === id) {
        stickToBottom.current = true
        setShowJumpToLatest(false)
        resetLiveTurnState()
        setBlocks([])
        setThread(null)
        const t = await send('thread/start', userApprovalParams())
        applyThreadRuntime(t.result)
        setThread(t.result?.thread?.id ?? null)
      }
    } catch (err: any) { toast('error', err?.message ?? String(err)) }
  }

  const stopTurn = async () => {
    const active = currentTurn.current
    if (!ready || !thread || !active) return
    try {
      const result = await send('turn/interrupt', { threadId: thread, turnId: active.turnId })
      if (result.error) throw new Error(result.error.message)
      toast('info', 'Stopping current turn…')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const pickAttachments = async () => {
    if (!ready || streaming) return
    try {
      const result = await window.zspark.pickAttachments()
      if (result.errors.length) toast('warn', result.errors.join('\n'))
      if (result.attachments.length) {
        const picked = result.attachments.map((a) => ({ ...a, id: `att-${Date.now()}-${Math.random()}` }))
        setAttachments((prev) => [
          ...prev,
          ...picked
        ])
        upsertWorkspaceFiles(picked.map((a) => ({
          id: `file-${a.id}`,
          name: a.name,
          path: a.path,
          source: 'attachment',
          status: 'attached',
          updatedAt: Date.now()
        })))
        addRecommendedSkillsForAttachments(picked)
      }
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  const useSkill = (skill: SkillMeta) => {
    if (!skill.path) return
    setSelectedSkills((prev) => {
      if (prev.some((s) => s.path === skill.path)) return prev
      return [...prev, skill]
    })
    setPanel(null)
  }

  const removeSkill = (path?: string) => setSelectedSkills((prev) => prev.filter((s) => s.path !== path))

  const openSkillPath = async (path?: string) => {
    if (!path) return
    try {
      const result = await window.zspark.openPath(path)
      if (!result.ok) toast('error', result.error ?? 'Could not open skill file')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const openFilePath = async (path?: string) => {
    if (!path) return
    try {
      const result = await window.zspark.openPath(path)
      if (!result.ok) toast('error', result.error ?? 'Could not open file')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const revealFilePath = async (path?: string) => {
    if (!path) return
    try {
      const result = await window.zspark.revealPath(path)
      if (!result.ok) toast('error', result.error ?? 'Could not reveal file')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const downloadFilePath = async (path?: string) => {
    if (!path) return
    try {
      const result = await window.zspark.downloadPath(path)
      if (result.ok) {
        toast('info', `Saved to ${shortPath(result.path)}`)
      } else if (!result.canceled) {
        toast('error', result.error ?? 'Could not download file')
      }
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const refreshSkills = async (forceReload = false) => {
    const [local, visible] = await Promise.all([
      window.zspark.discoverLocalSkills(),
      ready ? send('skills/list', { forceReload }) : Promise.resolve({ result: { data: [] } })
    ])

    if (local.errors.length) toast('warn', local.errors.slice(0, 3).join('\n'))
    setLocalSkills(local.skills)

    const all: SkillMeta[] = []
    for (const e of visible.result?.data ?? []) {
      for (const s of e.skills ?? []) {
        all.push({
          name: s.name,
          description: s.description,
          shortDescription: s.shortDescription ?? s.interface?.shortDescription,
          displayName: s.interface?.displayName,
          path: s.path,
          scope: s.scope,
          enabled: s.enabled,
          dependencies: s.dependencies,
          availability: 'usable'
        })
      }
    }
    setSkills(all)
  }

  const setSkillEnabled = async (skill: SkillMeta, enabled: boolean) => {
    if (!skill.path || skill.availability === 'localOnly') return
    try {
      await send('skills/config/write', { path: skill.path, enabled })
      await refreshSkills(true)
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const addRecommendedSkillsForAttachments = (picked: AttachmentMeta[]) => {
    const usable = skills.filter((s) => s.path && s.enabled !== false)
    const selected: SkillMeta[] = []
    for (const attachment of picked) {
      const names = recommendedSkillNamesForAttachment(attachment).map((name) => name.toLowerCase())
      const skill = usable.find((s) => {
        const display = (s.displayName ?? '').toLowerCase()
        const name = s.name.toLowerCase()
        return names.includes(name) || names.includes(display)
      })
      if (skill && !selected.some((s) => s.path === skill.path)) selected.push(skill)
    }
    if (selected.length) {
      setSelectedSkills((prev) => {
        const seen = new Set(prev.map((s) => s.path))
        return [...prev, ...selected.filter((s) => !seen.has(s.path))]
      })
    }
  }

  const openPanel = async (p: Panel) => {
    setPanel(p)
    if (p === 'skills') {
      try { await refreshSkills(true) } catch {}
      return
    }
    if (p === 'plugins') {
      try {
        const local = await window.zspark.discoverLocalSkills()
        setLocalSkills(local.skills)
      } catch {}
    }
    if (!ready) return
    if (p === 'history' || p === 'search') {
      try {
        const r = await send('thread/list', { limit: 50 })
        setThreads(r.result?.data ?? [])
      } catch {}
    }
  }
  const submit = async (
    override?: string,
    options: { inputItems?: TurnInputItem[]; attachments?: AttachmentMeta[]; skills?: SkillMeta[]; clearComposer?: boolean } = {}
  ) => {
    const fromComposer = override === undefined
    const providedInput = options.inputItems?.filter(Boolean) ?? []
    const currentAttachments = options.attachments ?? (fromComposer ? attachments : [])
    const currentSkills = options.skills ?? (fromComposer ? selectedSkills : [])
    const rawText = (override ?? input).trim()
    if (streaming || submitInFlight.current) {
      toast('warn', 'Current turn is still running. Stop it or wait before sending another message.')
      return
    }
    if ((!rawText && currentAttachments.length === 0 && currentSkills.length === 0 && providedInput.length === 0) || !ready) return
    submitInFlight.current = true
    setSubmitting(true)
    stickToBottom.current = true
    setShowJumpToLatest(false)
    const text = rawText || (currentAttachments.length ? suggestedPromptForAttachments(currentAttachments) : '')
    const shouldClearComposer = fromComposer || options.clearComposer === true
    if (shouldClearComposer) {
      clearComposerText()
      setAttachments([])
      setSelectedSkills([])
    }
    let inputItems: TurnInputItem[] = [...providedInput]
    if (inputItems.length === 0) {
      const contextLines: string[] = []
      for (const skill of currentSkills) {
        if (skill.path) {
          inputItems.push({ type: 'skill', name: skill.name, path: skill.path })
          contextLines.push(`Use skill: ${skill.name}`)
        }
      }
      contextLines.push(...officeRuntimeContext(currentSkills, runtimeRef.current))
      contextLines.push(...executionSafetyContext(text))
      for (const attachment of currentAttachments) {
        if (attachment.kind === 'image') {
          inputItems.push({ type: 'localImage', path: attachment.path })
          contextLines.push(`Attached image: ${attachment.name} (workspace copy: ${attachment.path})`)
        } else {
          contextLines.push(`Attached file: ${attachment.name} (writable workspace copy: ${attachment.path})`)
        }
      }
      if (text || contextLines.length) {
        const message = [text, ...contextLines].filter(Boolean).join('\n\n')
        inputItems.unshift({ type: 'text', text: message, textElements: [] })
      }
    }
    let accepted = false
    try {
      const res = await send('turn/start', { threadId: thread, input: inputItems, ...userApprovalParams() })
      if (res.error) {
        if (shouldClearComposer) {
          setInput(text)
          setAttachments(currentAttachments)
          setSelectedSkills(currentSkills)
        }
        toast('error', res.error.message)
      } else {
        accepted = true
        const acceptedTurnId = res.result?.turn?.id
        window.setTimeout(() => {
          if (submitInFlight.current && currentTurn.current?.turnId !== acceptedTurnId) {
            submitInFlight.current = false
            setSubmitting(false)
          }
        }, 3000)
      }
    } catch (e: any) {
      if (shouldClearComposer) {
        setInput(text)
        setAttachments(currentAttachments)
        setSelectedSkills(currentSkills)
      }
      toast('error', e?.message ?? String(e))
    } finally {
      // Successful turn/start hands the lock to turn/started. Failures never
      // emit a turn boundary, so release the composer here.
      if (!accepted) {
        submitInFlight.current = false
        setSubmitting(false)
      }
    }
  }

  const turnIdsFromBlocks = (source = blocks) => {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const block of source) {
      const turnId = 'turnId' in block ? block.turnId : undefined
      if (turnId && !seen.has(turnId)) {
        seen.add(turnId)
        ids.push(turnId)
      }
    }
    return ids
  }

  const replaceBlocksFromThread = (threadForReplay: any) => {
    const threadId = threadForReplay?.id ?? thread
    const replay = blocksFromThreadTurns(threadForReplay?.turns ?? [], runtimeRef.current.cwd ?? runtimeRef.current.workspaceRoot)
    const restoredBlocks = threadId ? mergePersistedActivityBlocks(replay.blocks, loadPersistedActivityBlocks(threadId)) : replay.blocks
    if (replay.files.length) upsertWorkspaceFiles(replay.files)
    setBlocks(restoredBlocks)
  }

  const rollbackFromTurn = async (turnId: string, action: 'delete' | 'regenerate') => {
    if (!ready || !thread) return false
    const turnIds = turnIdsFromBlocks()
    const index = turnIds.indexOf(turnId)
    if (index === -1) return false
    const numTurns = turnIds.length - index
    if (numTurns > 1) {
      const label = action === 'regenerate' ? 'Regenerate' : 'Delete'
      if (!confirm(`${label} this turn? This will remove this turn and ${numTurns - 1} later turn${numTurns === 2 ? '' : 's'} from model context.`)) {
        return false
      }
    }
    setMessageActionBusy(true)
    try {
      const res = await send('thread/rollback', { threadId: thread, numTurns })
      if (res.error) throw new Error(res.error.message)
      resetLiveTurnState()
      applyThreadRuntime(res.result)
      setThread(res.result?.thread?.id ?? thread)
      replaceBlocksFromThread(res.result?.thread)
      return true
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
      return false
    } finally {
      setMessageActionBusy(false)
    }
  }

  const findSourceUserBlock = (block: MessageBlock) => {
    if (block.type === 'user') return block
    const index = blocks.findIndex((candidate) => candidate.id === block.id)
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = blocks[i]
      if (candidate?.type === 'user') return candidate
    }
    return undefined
  }

  const copyMessageBlock = async (block: MessageBlock) => {
    const text = block.type === 'user' ? stripInternalPromptContext(block.text) : block.text.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast('info', 'Copied')
    } catch (err: any) {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', 'true')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      document.body.removeChild(textarea)
      if (copied) toast('info', 'Copied')
      else toast('error', err?.message ?? 'Could not copy message')
    }
  }

  const deleteMessageBlock = async (block: MessageBlock) => {
    if (streaming || submitInFlight.current || messageActionBusy) {
      toast('warn', 'Current turn is still running. Stop it or wait before editing history.')
      return
    }
    const source = findSourceUserBlock(block)
    const turnId = block.turnId ?? source?.turnId
    if (turnId) {
      const didRollback = await rollbackFromTurn(turnId, 'delete')
      if (didRollback) toast('info', 'Removed from context')
      return
    }
    setBlocks((bs) => bs.filter((candidate) => candidate.id !== block.id))
    toast('info', 'Hidden locally')
  }

  const regenerateMessageBlock = async (block: MessageBlock) => {
    if (streaming || submitInFlight.current || messageActionBusy) {
      toast('warn', 'Current turn is still running. Stop it or wait before regenerating.')
      return
    }
    const source = findSourceUserBlock(block)
    const text = stripInternalPromptContext(source?.text ?? '')
    if (!source || !text) {
      toast('warn', 'No user prompt found for this response.')
      return
    }
    if (source.turnId) {
      const didRollback = await rollbackFromTurn(source.turnId, 'regenerate')
      if (!didRollback) return
    }
    await submit(text, { inputItems: source.input?.length ? source.input : undefined })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (streaming || submitInFlight.current) {
      e.preventDefault()
      toast('warn', 'Current turn is still running. Stop it or wait before sending another message.')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }
  const toggleTurn = (turnId: string) =>
    updateTurn(turnId, (t) => ({ ...t, collapsed: !t.collapsed }))

  const composerBusy = streaming || submitting
  const statusClass = ready ? (composerBusy ? 'streaming' : 'live') : 'off'
  const statusText = ready ? (streaming ? 'streaming' : submitting ? 'starting' : 'ready') : 'connecting'
  const hasComposerContent = input.trim().length > 0 || attachments.length > 0 || selectedSkills.length > 0
  const catalogSkills = useMemo(() => {
    const visiblePaths = new Set(skills.map((s) => s.path).filter(Boolean))
    const visibleNames = new Set(skills.map((s) => s.name.toLowerCase()))
    const localOnly = localSkills
      .filter((s) => !visiblePaths.has(s.path) && !visibleNames.has(s.name.toLowerCase()))
      .map((s): SkillMeta => ({
        ...s,
        availability: 'localOnly',
        enabled: false,
        scope: undefined
      }))
    return [...skills.map((s) => ({ ...s, availability: 'usable' as const })), ...localOnly]
  }, [skills, localSkills])
  const visibleSkills = useMemo(
    () => filterSkillCatalog(catalogSkills, skillCategory, skillQuery) as SkillMeta[],
    [catalogSkills, skillCategory, skillQuery]
  )
  const usableSkillCount = skills.filter((s) => s.enabled !== false).length
  const localOnlyOfficeCount = catalogSkills.filter((s) => s.availability === 'localOnly' && inferSkillCategory(s) === 'office').length
  const pluginCacheSkills = localSkills.filter((s) => s.source === 'pluginCache')
  const visibleSkillPaths = new Set(skills.map((s) => s.path).filter(Boolean))
  const runtimeCwd = runtime.cwd ?? runtime.workspaceRoot
  const runtimeProvider = runtime.provider?.model ?? runtime.model
  const runtimeProviderName = runtime.modelProvider ?? (runtime.provider ? 'zspark' : undefined)
  const streamingAgentId = currentTurn.current ? agentForTurn.current.get(currentTurn.current.turnId) : undefined

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">z</div>
          <div className="brand-copy">
            <strong>zspark</strong>
            <span>agent workspace</span>
          </div>
        </div>
        <div className="nav-item active" onClick={newChat}><IconNewChat /><span>New chat</span></div>
        <div className="nav-item" onClick={() => openPanel('search')}><IconSearch /><span>Search</span></div>
        <div className="nav-item" onClick={() => openPanel('skills')}><IconSkills /><span>Skills</span></div>
        <div className="nav-item" onClick={() => openPanel('plugins')}><IconPlugins /><span>Plugins</span></div>
        <div className="nav-item" onClick={() => openPanel('automations')}><IconAutomations /><span>Automations</span></div>
        <h3>Recent</h3>
        {threads.slice(0, 8).map((t) => (
          <div key={t.id} className={`nav-item nav-item-thread${thread === t.id ? ' active' : ''}`} onClick={() => switchThread(t.id)}>
            <IconProject />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{displayThreadPreview(t)}</span>
            <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete chat" title="Delete chat"><IconClose /></button>
          </div>
        ))}
        {threads.length === 0 && <div className="nav-item" onClick={() => openPanel('history')} style={{ color: '#a1a1aa' }}><IconProject /><span>No chats yet</span></div>}
      </aside>

      <main className="chat">
        <div className="chat-header">
          <div className="left workspace-title">
            <span>Workspace</span>
            <small title={runtimeCwd}>{shortPath(runtimeCwd)}</small>
          </div>
          <div className="right">
            {streaming && <button className="header-btn danger" onClick={stopTurn}><IconClose /> Stop</button>}
            <button className="header-btn" onClick={() => setShowSettings(true)}><IconSettings /> Provider</button>
            <span className={`status-dot ${statusClass}`}>{statusText}</span>
          </div>
        </div>

        <div className="chat-stream" ref={streamRef} onScroll={updateStreamScrollState} onWheel={handleStreamWheel} onTouchMove={() => pauseAutoScroll()}>
          {blocks.length === 0 ? (
            <div className="empty">
              <div className="h">What should we build?</div>
              <div className="sub">Draft, review, automate. zspark works as your daily co-worker.</div>
              <div className="grid">
                {starters.map((s) => (
                  <div className="card" key={s.t} onClick={() => submit(s.d)}>
                    <div className="t">{s.t}</div>
                    <div className="d">{s.d}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            blocks.map((b) => {
              if (b.type === 'user') {
                const visibleText = stripInternalPromptContext(b.text)
                return (
                  <div key={b.id} className="message-wrap user">
                    <div className="bubble user">{visibleText}</div>
                    <MessageActions
                      onCopy={() => void copyMessageBlock(b)}
                      onDelete={() => void deleteMessageBlock(b)}
                      onRegenerate={() => void regenerateMessageBlock(b)}
                      disabled={composerBusy || messageActionBusy}
                      copyDisabled={!visibleText}
                    />
                  </div>
                )
              }
              if (b.type === 'agent') {
                const isStreamingAgent = streaming && b.id === streamingAgentId
                const artifactCandidates = extractArtifactPathCandidates(b.text)
                return (
                  <div key={b.id} className="message-wrap assistant">
                    <div className={`bubble assistant${isStreamingAgent ? ' streaming' : ''}`}>
                      <Markdown text={b.text} />
                      <MemoryCitationPill citation={b.memoryCitation} />
                      <MessageArtifactButtons
                        candidates={artifactCandidates}
                        runtime={runtime}
                        onDownload={downloadFilePath}
                        onOpen={openFilePath}
                      />
                    </div>
                    <MessageActions
                      onCopy={() => void copyMessageBlock(b)}
                      onDelete={() => void deleteMessageBlock(b)}
                      onRegenerate={() => void regenerateMessageBlock(b)}
                      disabled={composerBusy || messageActionBusy || isStreamingAgent}
                      copyDisabled={!b.text.trim()}
                    />
                  </div>
                )
              }
              if (b.type === 'files') {
                return (
                  <div key={b.id} className={`artifact-card${b.tone === 'warn' ? ' warn' : ''}`}>
                    <div className="artifact-head">
                      <div>
                        <div className="artifact-title">{b.title}</div>
                        <div className="artifact-sub">{b.subtitle ?? 'Generated in this turn'}</div>
                      </div>
                      <IconFile />
                    </div>
                    <div className="artifact-list">
                      {b.files.map((file) => (
                        <div className="artifact-row" key={file.path}>
                          <div className="artifact-file">
                            <span className={`file-status file-status-${file.status}`}>{file.status}</span>
                            <button title={file.path} onClick={() => openFilePath(file.path)} disabled={file.status === 'missing'}>{file.name}</button>
                            <small title={file.path}>{shortPath(file.path)}</small>
                          </div>
                          <div className="artifact-actions">
                            <button className="primary" onClick={() => downloadFilePath(file.path)} disabled={file.status === 'missing'}>Download</button>
                            <button onClick={() => openFilePath(file.path)} disabled={file.status === 'missing'}>Open</button>
                            <button onClick={() => revealFilePath(file.path)} disabled={file.status === 'missing'}>Reveal</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              }
              if (b.type === 'approval') {
                return (
                  <ApprovalCard
                    key={b.id}
                    request={b.request}
                    onDecision={(request, approved) => void respondApproval(request, approved)}
                  />
                )
              }
              const dur = (b.endedAt ?? clock) - b.startedAt
              const running = !b.endedAt
              const failed = b.activities.some((a) => a.status === 'failed')
              const meaningful = b.activities.filter((a) => !(a.kind === 'reasoning' && a.id.startsWith('thinking-') && !a.detail))
              const summaryLabels = activitySummaryLabels(meaningful)
              const visibleActivities = displayActivities(b.activities)
              const stepsLabel = summaryLabels.length
                ? summaryLabels.slice(0, 2).join(' · ')
                : meaningful.length === 0
                ? (running ? 'waiting for activity' : (b.activities.some((a) => a.kind === 'reasoning' && a.detail) ? 'thought captured' : 'no tool activity'))
                : `${meaningful.length} step${meaningful.length === 1 ? '' : 's'}`
              return (
                <div key={b.id} className={`activity-card${b.collapsed ? ' collapsed' : ''}${running ? ' running' : ''}`}>
                  <div className="activity-head" onClick={() => toggleTurn(b.turnId)}>
                    <div className="head-left">
                      <span className={`spinner${running ? ' spin' : ''}${failed ? ' failed' : ''}`} />
                      <div className="head-copy">
                        <div className="head-line">
                          <span className="head-title">{running ? 'Working' : failed ? 'Needs attention' : 'Completed'}</span>
                          <span className="head-meta">Activity log · {fmtDuration(dur)} · {stepsLabel}</span>
                        </div>
                      </div>
                    </div>
                    <button className="chev" aria-label="Toggle"><IconChevron /></button>
                  </div>
                  {!b.collapsed && (
                    <div className="activity-body">
                      {summaryLabels.length > 0 && (
                        <div className="activity-summary" aria-label="Activity summary">
                          {summaryLabels.map((label) => <span key={label} className="activity-pill">{label}</span>)}
                        </div>
                      )}
                      {visibleActivities.length === 0 ? (
                        <div className="empty-act">Preparing…</div>
                      ) : visibleActivities.map((a) => {
                        const isPlaceholder = a.kind === 'reasoning' && a.id.startsWith('thinking-') && !a.detail && a.status === 'running'
                        const detail = publicActivityDetail(a)
                        return (
                          <div key={a.id} className={`act act-${a.kind} act-${a.status}`}>
                            <div className="act-icon">{actIcon(a.kind)}</div>
                            <div className="act-meat">
                              <div className="act-title">
                                {a.displayTitle}
                                {a.repeatCount > 1 ? ` x${a.repeatCount}` : ''}
                                {isPlaceholder ? ' · waiting for first token' : ''}
                              </div>
                              {detail && <div className="act-detail">{detail}</div>}
                              {a.status === 'failed' && <div className="act-note">Needs attention</div>}
                            </div>
                            <div className="act-status">
                              {a.status === 'running' ? '· · ·' :
                               a.status === 'failed' ? 'failed' :
                               a.endedAt ? fmtDuration(a.endedAt - a.startedAt) : ''}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
        {showJumpToLatest && (
          <button className="jump-latest" onClick={() => scrollToLatest()} aria-label="Jump to latest">
            Jump to latest
          </button>
        )}

        <div className="chat-input-wrap">
          <div className={`chat-input${composerBusy ? ' busy' : ''}`}>
            {(attachments.length > 0 || selectedSkills.length > 0) && (
              <div className="composer-chips">
                {selectedSkills.map((s) => (
                  <div key={s.path ?? s.name} className="composer-chip skill-chip" title={s.path}>
                    <IconSkills />
                    <span>{s.displayName ?? s.name}</span>
                    <button onClick={() => removeSkill(s.path)} aria-label={`Remove ${s.name}`}><IconClose /></button>
                  </div>
                ))}
                {attachments.map((a) => (
                  <div key={a.id} className={`composer-chip ${a.kind === 'image' ? 'image-chip' : ''}`} title={a.path}>
                    {a.kind === 'image' ? <IconImage /> : <IconFile />}
                    <span>{a.name}</span>
                    <em>{fmtBytes(a.size)}</em>
                    <button onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.name}`}><IconClose /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-row">
              <button className="attach-btn" onClick={pickAttachments} disabled={!ready || composerBusy} aria-label="Attach files" title="Attach files"><IconFile /></button>
              <textarea ref={taRef} rows={1} placeholder={composerBusy ? 'zspark is working…' : ready ? 'Ask zspark anything…' : 'Connecting…'}
                value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={!ready || composerBusy} />
              <button className="send-btn" onClick={() => submit()} disabled={!ready || composerBusy || !hasComposerContent} aria-label="Send"><IconSend /></button>
            </div>
          </div>
        </div>
      </main>

      <aside className="right">
        <div className="right-section">
          <h4>Session</h4>
          <div className="kv"><span className="k">Thread</span><span className="v">{thread ? thread.slice(0, 8) : '—'}</span></div>
          <div className="kv"><span className="k">Status</span><span className="v"><span className={`pill ${ready ? '' : 'off'}`}>{ready ? 'live' : 'offline'}</span></span></div>
          <div className="kv"><span className="k">Skills</span><span className="v">{usableSkillCount} ready</span></div>
        </div>
        <div className="right-section">
          <h4>Runtime</h4>
          <div className="kv"><span className="k">CWD</span><span className="v" title={runtimeCwd}>{shortPath(runtimeCwd)}</span></div>
          <div className="kv"><span className="k">Model</span><span className="v">{runtimeProvider ?? '—'}</span></div>
          <div className="kv"><span className="k">Provider</span><span className="v">{runtimeProviderName ?? '—'}</span></div>
          <div className="kv"><span className="k">Wire API</span><span className="v">{runtime.provider?.wireApi ?? 'responses'}</span></div>
          <div className="kv"><span className="k">Artifacts</span><span className="v">{runtime.workspaceRuntime?.available ? 'runtime ready' : 'runtime missing'}</span></div>
          <div className="kv"><span className="k">Sandbox</span><span className="v">{formatSandboxPolicy(runtime.sandbox, runtime.permissionProfile)}</span></div>
          <div className="kv"><span className="k">Approval</span><span className="v">{formatApprovalPolicy(runtime.approvalPolicy)}</span></div>
          {runtime.activePermissionProfile?.id && <div className="kv"><span className="k">Profile</span><span className="v">{runtime.activePermissionProfile.id}</span></div>}
        </div>
        <div className="right-section">
          <h4>Files</h4>
          <div className="file-actions">
            <button onClick={() => revealFilePath(runtime.attachmentDir)} disabled={!runtime.attachmentDir}>Attachments</button>
            <button onClick={() => revealFilePath(runtime.workspaceRoot)} disabled={!runtime.workspaceRoot}>Workspace</button>
          </div>
          {workspaceFiles.length === 0 ? (
            <div className="right-empty">No attached or changed files yet.</div>
          ) : (
            <div className="file-list">
              {workspaceFiles.slice(0, 8).map((file) => (
                <div className="file-row" key={file.path}>
                  <div className="file-row-main">
                    <span className={`file-status file-status-${file.status}`}>{file.status}</span>
                    <button title={file.path} onClick={() => openFilePath(file.path)}>{file.name}</button>
                  </div>
                  <button className="file-reveal" onClick={() => revealFilePath(file.path)}>Reveal</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {panel === 'search' && (
        <Drawer title="Search threads" onClose={() => setPanel(null)}>
          <input className="drawer-search" placeholder="Filter by preview…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <div className="drawer-list">
            {threads.filter((t) => !searchQuery || displayThreadPreview(t).toLowerCase().includes(searchQuery.toLowerCase())).map((t) => (
              <div key={t.id} className="drawer-row">
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => switchThread(t.id)}>
                  <div className="drawer-row-t">{displayThreadPreview(t)}</div>
                  <div className="drawer-row-d">{t.id.slice(0, 8)} · {t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : ''}</div>
                </div>
                <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete"><IconClose /></button>
              </div>
            ))}
            {threads.length === 0 && <div className="drawer-empty">No threads yet. Start a new chat to get going.</div>}
          </div>
        </Drawer>
      )}

      {panel === 'skills' && (
        <Drawer title="Skills" onClose={() => setPanel(null)}>
          <div className="skills-toolbar">
            <input className="drawer-search" placeholder="Search skills…" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
            <div className="skills-count">{visibleSkills.length}/{catalogSkills.length}</div>
          </div>
          <div className="skill-tabs">
            {skillCategoryOptions.map((option) => (
              <button key={option.id} className={skillCategory === option.id ? 'active' : ''} onClick={() => setSkillCategory(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="skill-summary">
            <strong>{usableSkillCount} usable now</strong>
            <span>{localSkills.length} detected locally. Only skills returned by app-server can be used in <code>turn/start</code>.</span>
            {localOnlyOfficeCount > 0 && <em>{localOnlyOfficeCount} office skill{localOnlyOfficeCount === 1 ? '' : 's'} found in plugin cache but not visible to this runtime.</em>}
          </div>
          <div className="skills-list">
            {visibleSkills.map((s, i) => (
              <div key={(s.path ?? s.name) + i} className={`skill-card${s.enabled === false ? ' disabled' : ''}${s.availability === 'localOnly' ? ' local-only' : ''}`}>
                <div className="skill-card-head">
                  <div className="skill-title">
                    <span>{s.displayName ?? s.name}</span>
                    {s.displayName && <small>{s.name}</small>}
                  </div>
                  <div className="skill-badges">
                    <span className={`skill-status ${skillStatusClass(s)}`}>{skillStatusLabel(s)}</span>
                    <span className="skill-source">{s.availability === 'localOnly' ? localSkillSourceLabel(s.source) : scopeLabel(s.scope)}</span>
                  </div>
                </div>
                <div className="skill-desc">{s.shortDescription || s.description || 'No description.'}</div>
                <div className="skill-meta-row">
                  <span>{inferSkillCategory(s)}</span>
                  {s.dependencies?.tools?.length ? <span>{s.dependencies.tools.length} tool deps</span> : <span>No tool deps listed</span>}
                </div>
                {s.path && <div className="skill-path">{s.path}</div>}
                <div className="skill-actions">
                  <button className="secondary" onClick={() => openSkillPath(s.path)} disabled={!s.path}>Open</button>
                  {s.availability === 'localOnly' ? (
                    <button disabled title="Detected on disk, but app-server did not list it as usable for this runtime.">Not visible</button>
                  ) : s.enabled === false ? (
                    <button onClick={() => setSkillEnabled(s, true)} disabled={!s.path}>Enable</button>
                  ) : (
                    <button onClick={() => useSkill(s)} disabled={!s.path}>Use</button>
                  )}
                </div>
              </div>
            ))}
            {catalogSkills.length === 0 && <div className="drawer-empty">No skills found in this workspace or local Codex skill roots.</div>}
            {catalogSkills.length > 0 && visibleSkills.length === 0 && <div className="drawer-empty">No matching skills.</div>}
          </div>
        </Drawer>
      )}

      {panel === 'plugins' && (
        <Drawer title="Plugins" onClose={() => setPanel(null)}>
          <p className="modal-hint">Plugin-backed skills are usable from zspark when app-server exposes them in <code>skills/list</code>. Cache-only entries are present on disk but not selectable for <code>turn/start</code>.</p>
          <div className="skill-summary">
            <strong>{pluginCacheSkills.length} plugin skill{pluginCacheSkills.length === 1 ? '' : 's'} detected</strong>
            <span>{pluginCacheSkills.filter((s) => visibleSkillPaths.has(s.path)).length} are visible to this runtime.</span>
          </div>
          <div className="skills-list">
            {pluginCacheSkills.map((skill) => {
              const visible = visibleSkillPaths.has(skill.path)
              return (
                <div className={`skill-card${visible ? '' : ' local-only'}`} key={skill.path}>
                  <div className="skill-card-head">
                    <div className="skill-title">
                      <span>{skill.displayName ?? skill.name}</span>
                      {skill.displayName && <small>{skill.name}</small>}
                    </div>
                    <div className="skill-badges">
                      <span className={`skill-status ${visible ? 'ready' : 'local'}`}>{visible ? 'Ready' : 'Cache'}</span>
                      <span className="skill-source">Plugin cache</span>
                    </div>
                  </div>
                  <div className="skill-desc">{skill.shortDescription || skill.description || 'No description.'}</div>
                  <div className="skill-path">{skill.path}</div>
                  <div className="skill-actions">
                    <button className="secondary" onClick={() => openSkillPath(skill.path)}>Open</button>
                    <button onClick={() => { setSkillCategory(inferSkillCategory(skill)); setPanel('skills') }}>View in Skills</button>
                  </div>
                </div>
              )
            })}
            {pluginCacheSkills.length === 0 && <div className="drawer-empty">No plugin cache skills found under local Codex plugin cache.</div>}
          </div>
        </Drawer>
      )}

      {panel === 'automations' && (
        <Drawer title="Automations" onClose={() => setPanel(null)}>
          <p className="modal-hint">Schedule recurring zspark tasks (daily standup digest, on-demand reports, Teams triggers).</p>
          <div className="drawer-empty">Coming in v0.2 — backed by zspark-server cron + Teams webhook.</div>
        </Drawer>
      )}

      {panel === 'history' && (
        <Drawer title="Chat history" onClose={() => setPanel(null)}>
          <div className="drawer-list">
            {threads.map((t) => (
              <div key={t.id} className="drawer-row">
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => switchThread(t.id)}>
                  <div className="drawer-row-t">{displayThreadPreview(t)}</div>
                  <div className="drawer-row-d">{t.id.slice(0, 8)}</div>
                </div>
                <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete"><IconClose /></button>
              </div>
            ))}
            {threads.length === 0 && <div className="drawer-empty">No history.</div>}
          </div>
        </Drawer>
      )}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="body">{t.text}</div>
            <button className="close" onClick={() => dismiss(t.id)} aria-label="Dismiss"><IconClose /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
