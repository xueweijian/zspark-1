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
  PROVIDER_RECONNECT_AUTO_INTERRUPT_MS,
  TURN_INTERRUPT_FALLBACK_RELEASE_MS,
  shouldRecoverFromProviderRetry,
  type CompletedTurnWorkKind
} from './turnRecovery'
import {
  approvalResponsePayload,
  approvalStatusForDecision,
  approvalStatusLabel,
  approvalTopline
} from './approvalHelpers'
import type {
  Activity,
  ActivityActionKind,
  ActivityInfo,
  ActivityKind,
  AppSettingsView,
  ApprovalDecisionMode,
  ApprovalKind,
  ApprovalRequest,
  ApprovalStatus,
  ArtifactScanResult,
  AttachmentMeta,
  Block,
  DiscoverLocalSkillsResult,
  EnterpriseConfig,
  EnterpriseDeviceCode,
  EnterpriseForm,
  EnterpriseStatus,
  JsonRpcId,
  LocalSkillMeta,
  MemoryCitation,
  MemoryCitationEntry,
  MessageBlock,
  Panel,
  PathStatResult,
  PickAttachmentsResult,
  ProviderForm,
  RuntimeHostInfo,
  RuntimeInfo,
  SharedArtifact,
  SharedSession,
  SharedSessionMutation,
  SharedSessionSnapshot,
  SharedWorkspace,
  SkillMeta,
  ThreadSummary,
  Toast,
  ToastKind,
  TurnInputItem,
  WorkspaceFile,
  WorkspaceRuntimeInfo
} from './appTypes'
import {
  IGNORED_RPC_ERRORS,
  errorMessage,
  isMissingRolloutError,
  pending,
  rejectPendingRequests,
  send,
  sendRpcError,
  sendRpcResult,
  shouldAutoToastRpcError
} from './ipc'
import {
  basename,
  blocksFromSharedSnapshot,
  changeKindLabel,
  describeChange,
  displaySkillName,
  displayThreadPreview,
  fmtBytes,
  fmtDuration,
  formatUserInputContent,
  findSharedWorkspaceFileForPath,
  isSharedArtifactPath,
  localSkillSourceLabel,
  normalizeInputItemsForResubmit,
  scopeLabel,
  sharedArtifactFile,
  sharedArtifactPath,
  sharedSessionToThread,
  skillStatusClass,
  skillStatusLabel,
  stripInternalPromptContext,
  titleFromBlocks,
  turnIdFromParams,
  upsertApprovalBlockByTurnOrder
} from './appHelpers'
import {
  ACTIVITY_STORAGE_PREFIX,
  actionKindForSummary,
  activityDetailWeight,
  activitySummaryLabels,
  cleanShellCommand,
  commandActionInfo,
  commandActivityDetail,
  commandActivityInfo,
  displayActivities,
  inferActionKindFromTitle,
  inferCommandInfo,
  itemTimeMs,
  loadPersistedActivityBlocks,
  memoryCitationDetail,
  memoryCitationTitle,
  mergePersistedActivityBlocks,
  normalizeActivity,
  normalizeMemoryCitation,
  orderBlocksForTurn,
  publicActivityDetail,
  publicActivityTitle,
  publicActivityTitleText,
  replayActivityFromItem,
  savePersistedActivityBlocks,
  serializePersistedActivityBlocks,
  shortenCommand,
  timestampToMs,
  titleizeToolName,
  toolActivityInfo,
  truncateActivityDetail,
  webSearchActivityInfo
} from './activityHelpers'

declare global {
  interface Window {
    zspark: {
      send: (line: string) => Promise<boolean>
      restart: () => Promise<boolean>
      pickAttachments: () => Promise<PickAttachmentsResult>
      getRuntimeInfo: () => Promise<RuntimeHostInfo>
      discoverLocalSkills: () => Promise<DiscoverLocalSkillsResult>
      openSkillPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      openPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>
      downloadPath: (path: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      statPath: (path: string) => Promise<PathStatResult>
      openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>
      scanRecentArtifacts: (options?: { sinceMs?: number; limit?: number }) => Promise<ArtifactScanResult>
      getSettings: () => Promise<AppSettingsView>
      saveSettings: (s: any) => Promise<{ ok: boolean; warnings?: string[]; error?: string }>
      enterpriseStatus: () => Promise<EnterpriseStatus>
      enterpriseLogin: () => Promise<{ ok: boolean; status?: EnterpriseStatus; error?: string }>
      enterpriseLogout: () => Promise<EnterpriseStatus>
      enterpriseWhoami: () => Promise<{ ok: boolean; principal?: string; oid?: string; tid?: string; status?: number; error?: string }>
      enterpriseWorkspaces: () => Promise<{ ok: boolean; workspaces?: SharedWorkspace[]; status?: number; error?: string }>
      enterpriseCreateWorkspace: (name?: string) => Promise<{ ok: boolean; workspace?: SharedWorkspace; status?: number; error?: string }>
      enterpriseSessions: (workspaceId: string) => Promise<{ ok: boolean; sessions?: SharedSession[]; status?: number; error?: string }>
      enterpriseCreateSession: (workspaceId: string, body?: SharedSessionMutation) => Promise<{ ok: boolean; session?: SharedSession; snapshotRevision?: number | null; status?: number; error?: string }>
      enterpriseReadSession: (workspaceId: string, sessionId: string) => Promise<{ ok: boolean; session?: SharedSession; snapshot?: SharedSessionSnapshot; status?: number; error?: string }>
      enterpriseUpdateSession: (workspaceId: string, sessionId: string, body?: SharedSessionMutation) => Promise<{ ok: boolean; session?: SharedSession; snapshotRevision?: number | null; status?: number; error?: string }>
      enterpriseDeleteSession: (workspaceId: string, sessionId: string) => Promise<{ ok: boolean; status?: number; error?: string }>
      enterpriseArtifacts: (workspaceId: string, sessionId: string) => Promise<{ ok: boolean; artifacts?: SharedArtifact[]; status?: number; error?: string }>
      enterpriseUploadArtifact: (workspaceId: string, sessionId: string, filePath: string, meta?: { name?: string; mimeType?: string; turnId?: string }) => Promise<{ ok: boolean; artifact?: SharedArtifact; status?: number; error?: string }>
      enterpriseDownloadArtifact: (workspaceId: string, sessionId: string, artifactId: string, name?: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; status?: number; error?: string }>
      enterpriseDownloadArtifactToCache: (workspaceId: string, sessionId: string, artifactId: string, name?: string) => Promise<{ ok: boolean; path?: string; status?: number; error?: string }>
      enterpriseOpenArtifactCache: (workspaceId?: string, sessionId?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      onEnterpriseDeviceCode: (cb: (payload: EnterpriseDeviceCode) => void) => void | (() => void)
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

// Renderer-internal constants kept colocated with App because every consumer
// is the App component itself. Pure helpers, types, and the IPC client live
// in `appTypes.ts`, `appHelpers.ts`, `activityHelpers.ts`, and `ipc.ts`.
const USER_APPROVAL_REVIEWER = 'user'
const ZSPARK_APPROVAL_POLICY = 'on-request'
const MAX_STDOUT_BUFFER_CHARS = 2_000_000

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

function ActivityDuration({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (endedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [endedAt])
  return <>{fmtDuration((endedAt ?? now) - startedAt)}</>
}

marked.setOptions({ gfm: true, breaks: true })

marked.setOptions({ gfm: true, breaks: true })

function secureMarkdownLinks(html: string) {
  return html.replace(/<a\s+([^>]*?)>/gi, (_match, attrs) => {
    let nextAttrs = String(attrs)
    if (!/\btarget=/i.test(nextAttrs)) nextAttrs += ' target="_blank"'
    if (!/\brel=/i.test(nextAttrs)) nextAttrs += ' rel="noopener noreferrer"'
    return `<a ${nextAttrs}>`
  })
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const normalized = normalizeMarkdownForDisplay(text || '')
    const sanitized = DOMPurify.sanitize(marked.parse(normalized, { async: false }) as string, {
      ADD_ATTR: ['target', 'rel'],
      // Only allow http(s)/mailto, fragments, and relative paths. The previous
      // regex was too permissive — anything whose first character was not a–z
      // (e.g. encoded `%` schemes) slipped through.
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i
    })
    return secureMarkdownLinks(sanitized)
  }, [text])
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element | null)?.closest?.('a[href]')
    const href = link?.getAttribute('href') ?? ''
    if (!link) return
    if (!/^(https?:|mailto:)/i.test(href)) {
      // Block unknown / unsafe schemes (e.g. `javascript:`, `file:`). Safe
      // schemes (relative URLs, fragments) are left to the browser default.
      if (href && !/^(?:#|\/|\.{1,2}\/)/.test(href)) event.preventDefault()
      return
    }
    event.preventDefault()
    void window.zspark.openExternalUrl(href)
  }
  return <div className="md" onClick={onClick} onAuxClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function artifactDownloadLabel(path: string) {
  const ext = basename(path).split('.').pop()?.toUpperCase()
  return ext ? `Download ${ext}` : 'Download'
}

function MessageArtifactButtons({
  candidates,
  runtime,
  workspaceFiles,
  onDownload,
  onOpen
}: {
  candidates: string[]
  runtime: RuntimeInfo
  workspaceFiles: WorkspaceFile[]
  onDownload: (path: string) => void
  onOpen: (path: string) => void
}) {
  const [artifacts, setArtifacts] = useState<Array<{ path: string; name: string; shared?: boolean }>>([])
  const candidatesKey = candidates.join('\n')
  const runtimeKey = `${runtime.cwd ?? ''}|${runtime.workspaceRoot ?? ''}`
  const sharedFiles = useMemo(() => workspaceFiles.filter((file) => file.sharedArtifact), [workspaceFiles])
  const sharedFilesKey = sharedFiles
    .map((file) => `${file.path}|${file.name}|${file.updatedAt}|${file.sharedArtifact?.artifactId ?? ''}`)
    .join('\n')

  useEffect(() => {
    let cancelled = false
    const verify = async () => {
      const seen = new Set<string>()
      const verified: Array<{ path: string; name: string; shared?: boolean }> = []
      for (const candidate of candidates.slice(0, 8)) {
        const sharedFile = findSharedWorkspaceFileForPath(sharedFiles, candidate)
        if (sharedFile) {
          if (!seen.has(sharedFile.path)) {
            seen.add(sharedFile.path)
            verified.push({ path: sharedFile.path, name: sharedFile.name, shared: true })
          }
          if (verified.length >= 4) break
          continue
        }
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
  }, [candidatesKey, runtimeKey, sharedFilesKey])

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
            <button onClick={() => onOpen(artifact.path)}>{artifact.shared ? 'Save' : 'Open'}</button>
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

function ApprovalCard({
  request,
  onDecision
}: {
  request: ApprovalRequest
  onDecision: (request: ApprovalRequest, mode: ApprovalDecisionMode) => void
}) {
  const actionable = request.status === 'pending'
  const compact = !actionable
  const approvedAll = request.status === 'approvedAll'
  return (
    <div className={`approval-card approval-${request.status}${compact ? ' approval-compact' : ''}`}>
      <div className="approval-mark"><IconShield /></div>
      <div className="approval-content">
        <div className="approval-topline">
          <span>{approvalTopline(request.status)}</span>
          <em>{approvalStatusLabel(request.status)}</em>
        </div>
        <div className="approval-title">{request.title}</div>
        {!compact && <div className="approval-desc">{request.description}</div>}
        {compact && approvedAll && <div className="approval-desc">Future actions in this run can continue without another prompt.</div>}
        {!compact && (request.reason || request.cwd || request.detail || request.commandPreview || request.paths.length > 0) && (
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
        {actionable && (
          <div className="approval-actions">
            <button className="approval-approve" onClick={() => onDecision(request, 'approve')}>Approve</button>
            <button className="approval-approve-all" onClick={() => onDecision(request, 'approveAll')}>Approve all</button>
            <button className="approval-deny" onClick={() => onDecision(request, 'deny')}>Deny</button>
          </div>
        )}
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
  const pythonRuntimeLine = rt.pythonAvailable
    ? `- Python executable: ${rt.pythonPath}`
    : `- Python executable: ${rt.pythonPath} (not found; use Node.js runtime unless a Python-only helper is required)`
  const lines = [
    'Zspark local runtime for the selected Office skill:',
    `- Node.js executable: ${rt.nodePath}`,
    `- Node.js packages: ${rt.nodeModulesPath}`,
    pythonRuntimeLine,
    'Use these bundled Node.js dependencies for presentations and other Node-based artifact helpers. Use Python only when the selected skill/helper requires it.',
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
  const [enterprise, setEnterprise] = useState<EnterpriseForm>({
    serverUrl: '',
    tenantId: '',
    clientId: '',
    apiScope: '',
    authority: ''
  })
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  useEffect(() => {
    window.zspark.getSettings().then((s) => {
      if (s.provider) setForm((p) => ({ ...p, ...s.provider }))
      if (s.enterprise) setEnterprise((p) => ({ ...p, ...s.enterprise }))
      setWarnings(s.warnings ?? [])
    })
  }, [])
  const save = async () => {
    setSaving(true)
    const result = await window.zspark.saveSettings({ provider: form, enterprise })
    setWarnings(result.warnings ?? [])
    setSaving(false)
    if (!result.ok) {
      setWarnings([result.error ?? 'Settings could not be saved', ...(result.warnings ?? [])])
      return
    }
    onClose()
  }
  return (
    <div className="modal-bg">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <div className="settings-group">
          <div>
            <h3>Model provider</h3>
            <p className="modal-hint">Standard OpenAI-compatible endpoint. Chat providers still run through zspark's local bridge.</p>
          </div>
          <label>Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
          <label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
          <label>Model<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
          <label>Wire API
            <select value={form.wireApi} onChange={(e) => setForm({ ...form, wireApi: e.target.value as any })}>
              <option value="responses">Responses API</option>
              <option value="chat">Chat Completions (via local bridge)</option>
            </select>
          </label>
          {warnings.length > 0 && (
            <div className="settings-warning" role="alert">
              {warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          )}
        </div>
        <div className="settings-group">
          <div>
            <h3>Shared workspaces</h3>
            <p className="modal-hint">Entra ID only gates access to the shared workspace server. It does not provide model API keys.</p>
          </div>
          <label>Server URL<input value={enterprise.serverUrl} onChange={(e) => setEnterprise({ ...enterprise, serverUrl: e.target.value })} placeholder="https://zspark.your-corp.cn" /></label>
          <label>Tenant ID<input value={enterprise.tenantId} onChange={(e) => setEnterprise({ ...enterprise, tenantId: e.target.value })} /></label>
          <label>Client ID<input value={enterprise.clientId} onChange={(e) => setEnterprise({ ...enterprise, clientId: e.target.value })} /></label>
          <label>API Scope<input value={enterprise.apiScope} onChange={(e) => setEnterprise({ ...enterprise, apiScope: e.target.value })} /></label>
          <label>Authority<input value={enterprise.authority} onChange={(e) => setEnterprise({ ...enterprise, authority: e.target.value })} /></label>
        </div>
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
  const [enterprise, setEnterprise] = useState<EnterpriseStatus | null>(null)
  const [enterpriseDeviceCode, setEnterpriseDeviceCode] = useState<EnterpriseDeviceCode | null>(null)
  const [enterpriseBusy, setEnterpriseBusy] = useState(false)
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null)
  const [sharedWorkspaces, setSharedWorkspaces] = useState<SharedWorkspace[]>([])
  const [activeSharedWorkspace, setActiveSharedWorkspace] = useState<string | null>(null)
  const [sharedSessions, setSharedSessions] = useState<SharedSession[]>([])
  const [activeSharedSession, setActiveSharedSession] = useState<string | null>(null)
  // Track current turn block id for incoming events
  const currentTurn = useRef<{ turnId: string; blockId: string; startedAt: number } | null>(null)
  // Map agent itemId (delta or completed) -> agent block id, scoped per turn
  const agentForTurn = useRef<Map<string, string>>(new Map())
  // Map item id -> activity id
  const itemActivity = useRef<Map<string, string>>(new Map())
  const approvalRequests = useRef<Map<string, ApprovalRequest>>(new Map())
  const autoApprovedTurns = useRef<Set<string>>(new Set())
  const seenTurnStarts = useRef<Set<string>>(new Set())
  const appliedReasoningCompletions = useRef<Set<string>>(new Set())
  const recentNotificationLines = useRef<Map<string, number>>(new Map())
  const restoredActivityThreads = useRef<Set<string>>(new Set())
  const checkedArtifactMessages = useRef<Map<string, string>>(new Map())
  const completedWorkByTurn = useRef<Map<string, Set<CompletedTurnWorkKind>>>(new Map())
  const commandFailuresByTurn = useRef<Map<string, CommandFailureSignal>>(new Map())
  const switchThreadSeq = useRef(0)
  const providerRetryTimers = useRef<Map<string, number>>(new Map())
  const interruptFallbackTimers = useRef<Map<string, number>>(new Map())
  const interruptingTurns = useRef<Set<string>>(new Set())
  const buf = useRef('')
  const streamRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = useRef('')
  const runtimeRef = useRef<RuntimeInfo>({})
  const threadRef = useRef<string | null>(null)
  const workspaceFilesRef = useRef<WorkspaceFile[]>([])
  const activeSharedWorkspaceRef = useRef<string | null>(null)
  const activeSharedSessionRef = useRef<string | null>(null)
  const lastLocalThreadRef = useRef<string | null>(null)
  const lastPersistedActivityKey = useRef('')
  const sharedSyncTimer = useRef<number | null>(null)
  const lastSharedSnapshotKey = useRef('')
  // Tracks the latest snapshotKey that has been scheduled. The `.then()`
  // callback only commits its key if it still matches — otherwise a slow
  // PATCH that resolves after a newer one would clobber the dedup state and
  // make us re-emit the freshly-applied snapshot on the next render tick.
  const inFlightSharedSnapshotKey = useRef('')
  const activeSharedSnapshotRevision = useRef<number | null>(null)
  const shownArtifactPaths = useRef<Set<string>>(new Set())
  const sharedArtifactUploads = useRef<Set<string>>(new Set())
  const submitInFlight = useRef(false)
  const stickToBottom = useRef(true)
  const programmaticScroll = useRef(false)

  const toast = (kind: ToastKind, text: string) => {
    const id = `t-${Date.now()}-${Math.random()}`
    // Cap on-screen toasts to keep the corner stack readable, and auto-dismiss
    // every kind (errors stay longer but no longer pile up forever).
    setToasts((p) => [...p, { id, kind, text }].slice(-8))
    setTimeout(() => dismiss(id), kind === 'error' ? 12000 : 4000)
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
  const refreshEnterprise = async (showErrors = false) => {
    try {
      const status = await window.zspark.enterpriseStatus()
      setEnterprise(status)
      if (status.signedIn) {
        const result = await window.zspark.enterpriseWorkspaces()
        if (result.ok) {
          setEnterpriseError(null)
          const workspaces = result.workspaces ?? []
          setSharedWorkspaces(workspaces)
          if (activeSharedWorkspaceRef.current && !workspaces.some((workspace) => workspace.id === activeSharedWorkspaceRef.current)) {
            activeSharedWorkspaceRef.current = null
            activeSharedSessionRef.current = null
            activeSharedSnapshotRevision.current = null
            setActiveSharedWorkspace(null)
            setActiveSharedSession(null)
            setSharedSessions([])
          }
        } else {
          const message = result.error ?? 'Could not load shared workspaces'
          setEnterpriseError(message)
          if (showErrors) toast('error', message)
          setSharedWorkspaces([])
        }
      } else {
        setEnterpriseError(null)
        setSharedWorkspaces([])
        setSharedSessions([])
        activeSharedWorkspaceRef.current = null
        activeSharedSessionRef.current = null
        activeSharedSnapshotRevision.current = null
        setActiveSharedWorkspace(null)
        setActiveSharedSession(null)
      }
    } catch {
      const message = 'Could not reach shared workspace server'
      setEnterpriseError(message)
      if (showErrors) toast('error', message)
      setSharedWorkspaces([])
      setSharedSessions([])
    }
  }
  const refreshSharedSessions = async (workspaceId = activeSharedWorkspaceRef.current, showErrors = false) => {
    if (!workspaceId) {
      setSharedSessions([])
      return
    }
    try {
      const result = await window.zspark.enterpriseSessions(workspaceId)
      if (!result.ok) {
        const message = result.error ?? 'Could not load shared sessions'
        setEnterpriseError(message)
        if (showErrors) toast('error', message)
        setSharedSessions([])
        return
      }
      setEnterpriseError(null)
      setSharedSessions(result.sessions ?? [])
    } catch (err: any) {
      const message = err?.message ?? 'Could not reach shared workspace server'
      setEnterpriseError(message)
      if (showErrors) toast('error', message)
      setSharedSessions([])
    }
  }
  const selectSharedWorkspace = async (workspaceId: string) => {
    if (streaming || submitInFlight.current) {
      toast('warn', 'Current turn is still running. Stop it or wait before switching workspace.')
      return
    }
    if (!activeSharedWorkspaceRef.current && threadRef.current) {
      const localThread = threadRef.current
      const knownLocalThread = threads.some((candidate) => candidate.id === localThread)
      const hasLocalTranscript = blocks.some((block) => (
        block.type === 'user' || block.type === 'agent' || block.type === 'turn'
      ))
      lastLocalThreadRef.current = knownLocalThread || hasLocalTranscript ? localThread : null
    }
    switchThreadSeq.current += 1
    resetLiveTurnState()
    activeSharedWorkspaceRef.current = workspaceId
    activeSharedSessionRef.current = null
    activeSharedSnapshotRevision.current = null
    setActiveSharedWorkspace(workspaceId)
    setActiveSharedSession(null)
    setThread(null)
    setBlocks([])
    setWorkspaceFiles([])
    setPanel(null)
    await refreshSharedSessions(workspaceId, true)
  }
  const exitSharedWorkspace = async () => {
    if (streaming || submitInFlight.current) {
      toast('warn', 'Current turn is still running. Stop it or wait before switching workspace.')
      return
    }
    const localThread = lastLocalThreadRef.current
    switchThreadSeq.current += 1
    resetLiveTurnState()
    activeSharedWorkspaceRef.current = null
    activeSharedSessionRef.current = null
    activeSharedSnapshotRevision.current = null
    setActiveSharedWorkspace(null)
    setActiveSharedSession(null)
    setSharedSessions([])
    setBlocks([])
    setWorkspaceFiles([])
    setPanel(null)
    if (localThread) {
      await switchLocalThread(localThread, { startNewOnMissingRollout: true })
    } else {
      await startLocalChat()
    }
  }
  const signInEnterprise = async () => {
    setEnterpriseBusy(true)
    setEnterpriseError(null)
    setEnterpriseDeviceCode(null)
    try {
      const result = await window.zspark.enterpriseLogin()
      if (!result.ok) {
        toast('error', result.error ?? 'Could not sign in to shared workspaces')
        return
      }
      if (result.status) setEnterprise(result.status)
      toast('info', 'Signed in to shared workspaces')
      await refreshEnterprise(true)
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }
  const signOutEnterprise = async () => {
    setEnterpriseBusy(true)
    try {
      const status = await window.zspark.enterpriseLogout()
      setEnterprise(status)
      setEnterpriseError(null)
      setSharedWorkspaces([])
      setSharedSessions([])
      activeSharedWorkspaceRef.current = null
      activeSharedSessionRef.current = null
      activeSharedSnapshotRevision.current = null
      setActiveSharedWorkspace(null)
      setActiveSharedSession(null)
      toast('info', 'Signed out of shared workspaces')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }
  const createSharedWorkspace = async () => {
    const accountName = enterprise?.account?.name || enterprise?.account?.username
    const name = `${accountName ? accountName.split('@')[0] : 'Team'} shared workspace`
    setEnterpriseBusy(true)
    setEnterpriseError(null)
    try {
      const result = await window.zspark.enterpriseCreateWorkspace(name)
      if (!result.ok) {
        const message = result.error ?? 'Could not create shared workspace'
        setEnterpriseError(message)
        toast('error', message)
        return
      }
      await refreshEnterprise(true)
      if (result.workspace?.id) await selectSharedWorkspace(result.workspace.id)
      toast('info', 'Shared workspace created')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    } finally {
      setEnterpriseBusy(false)
    }
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
    const displayFiles = activeSharedWorkspaceRef.current
      ? files.filter((file) => file.sharedArtifact || file.status === 'missing')
      : files
    if (displayFiles.length === 0) return
    const id = `files-${itemId}`
    const title = options.title ?? `${displayFiles.length} file${displayFiles.length === 1 ? '' : 's'} ready`
    for (const file of displayFiles) {
      if (file.status !== 'missing') shownArtifactPaths.current.add(file.path)
    }
    setBlocks((bs) => {
      const next = { type: 'files' as const, id, turnId, title, files: displayFiles, subtitle: options.subtitle, tone: options.tone ?? 'normal' }
      if (bs.some((b) => b.id === id)) return bs.map((b) => (b.id === id ? next : b))
      return [...bs, next]
    })
  }

  const uploadSharedArtifacts = async (files: WorkspaceFile[], turnId: string) => {
    const workspaceId = activeSharedWorkspaceRef.current
    const sessionId = activeSharedSessionRef.current
    if (!workspaceId || !sessionId) return files

    return Promise.all(files.map(async (file) => {
      if (file.sharedArtifact || isSharedArtifactPath(file.path) || file.status === 'missing' || file.status === 'deleted') return file
      const key = `${workspaceId}:${sessionId}:${file.path}:${file.updatedAt}`
      if (sharedArtifactUploads.current.has(key)) return file
      sharedArtifactUploads.current.add(key)
      try {
        const result = await window.zspark.enterpriseUploadArtifact(workspaceId, sessionId, file.path, {
          name: file.name,
          turnId
        })
        if (!result.ok || !result.artifact) {
          sharedArtifactUploads.current.delete(key)
          if (result.error) toast('warn', `Shared upload failed: ${result.error}`)
          return file
        }
        const artifact = result.artifact
        return {
          ...file,
          detail: `${file.detail ?? 'Generated artifact'} · uploaded to shared workspace`,
          sharedArtifact: {
            workspaceId,
            sessionId,
            artifactId: artifact.id,
            sizeBytes: artifact.size_bytes
          }
        }
      } catch (err: any) {
        sharedArtifactUploads.current.delete(key)
        toast('warn', `Shared upload failed: ${err?.message ?? String(err)}`)
        return file
      }
    }))
  }

  const fetchSharedArtifactFiles = async (workspaceId: string, sessionId: string, showErrors = false) => {
    try {
      const result = await window.zspark.enterpriseArtifacts(workspaceId, sessionId)
      if (!result.ok) {
        if (showErrors) toast('error', result.error ?? 'Could not load shared artifacts')
        return []
      }
      return (result.artifacts ?? []).map((artifact) => sharedArtifactFile(workspaceId, sessionId, artifact))
    } catch (err: any) {
      if (showErrors) toast('error', err?.message ?? 'Could not load shared artifacts')
      return []
    }
  }

  const withSharedArtifactBlock = (source: Block[], files: WorkspaceFile[], sessionId: string) => {
    if (!files.length) return source
    const id = `files-shared-${sessionId}`
    const block: Extract<Block, { type: 'files' }> = {
      type: 'files',
      id,
      turnId: `shared-artifacts-${sessionId}`,
      title: `${files.length} shared artifact${files.length === 1 ? '' : 's'} ready`,
      files,
      subtitle: 'Synced from the shared workspace'
    }
    const sourceWithoutResolvedMissing = source.flatMap((candidate) => {
      if (candidate.type !== 'files' || candidate.tone !== 'warn') return [candidate]
      const unresolved = candidate.files.filter((file) => (
        file.status !== 'missing' || !findSharedWorkspaceFileForPath(files, file.path)
      ))
      return unresolved.length ? [{ ...candidate, files: unresolved }] : []
    })
    return sourceWithoutResolvedMissing.some((candidate) => candidate.id === id)
      ? sourceWithoutResolvedMissing.map((candidate) => (candidate.id === id ? block : candidate))
      : [...sourceWithoutResolvedMissing, block]
  }

  const refreshSharedArtifactsForActiveSession = async (showErrors = false) => {
    const workspaceId = activeSharedWorkspaceRef.current
    const sessionId = activeSharedSessionRef.current
    if (!workspaceId || !sessionId) return []
    const files = await fetchSharedArtifactFiles(workspaceId, sessionId, showErrors)
    if (!files.length) {
      if (showErrors) toast('info', 'No shared artifacts for this session yet.')
      return []
    }
    upsertWorkspaceFiles(files)
    setBlocks((bs) => withSharedArtifactBlock(bs, files, sessionId))
    return files
  }

  const scanTurnArtifacts = async (turnId: string, startedAt: number, itemId: string) => {
    try {
      const result = await window.zspark.scanRecentArtifacts({
        sinceMs: Math.max(0, startedAt - 2000),
        limit: 12
      })
      let files: WorkspaceFile[] = result.artifacts
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
      files = await uploadSharedArtifacts(files, turnId)
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
    const refreshedSharedFiles = activeSharedWorkspaceRef.current && activeSharedSessionRef.current
      ? await refreshSharedArtifactsForActiveSession(false)
      : []
    const sharedFiles = [...refreshedSharedFiles, ...workspaceFilesRef.current]
    await Promise.all(candidates.map(async (candidate, index) => {
      const sharedFile = findSharedWorkspaceFileForPath(sharedFiles, candidate)
      if (sharedFile) {
        existing.push({
          ...sharedFile,
          id: `claim-shared-${now}-${index}`,
          status: 'created',
          detail: `${sharedFile.detail ?? 'Shared artifact'} · found in shared workspace`
        })
        return
      }
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
      const sharedExisting = await uploadSharedArtifacts(existing, turnId)
      upsertWorkspaceFiles(sharedExisting)
      upsertArtifactBlock(turnId, `${itemId}-verified`, sharedExisting, {
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
    const refreshedSharedFiles = activeSharedWorkspaceRef.current && activeSharedSessionRef.current
      ? await refreshSharedArtifactsForActiveSession(false)
      : []
    const sharedFiles = [...refreshedSharedFiles, ...workspaceFilesRef.current]
    for (const candidate of candidates) {
      const sharedFile = findSharedWorkspaceFileForPath(sharedFiles, candidate)
      if (sharedFile) {
        files.push({
          ...sharedFile,
          id: `inline-shared-${agentBlock.id}-${files.length}-${now}`,
          detail: `${sharedFile.detail ?? 'Shared artifact'} · found in shared workspace`
        })
        continue
      }
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
    const uploadedFiles = await uploadSharedArtifacts(files, agentBlock.turnId ?? `agent-${agentBlock.id}`)
    checkedArtifactMessages.current.set(agentBlock.id, signature)
    upsertWorkspaceFiles(uploadedFiles)
    upsertArtifactBlock(agentBlock.turnId ?? `agent-${agentBlock.id}`, `${agentBlock.id}-inline-artifacts`, uploadedFiles, {
      title: `${uploadedFiles.length} downloadable artifact${uploadedFiles.length === 1 ? '' : 's'} ready`,
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
          status: 'running' as const,
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
          status: 'running' as const,
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
      const block: Extract<Block, { type: 'approval' }> = { type: 'approval', id: request.blockId, turnId: request.turnId, request }
      return upsertApprovalBlockByTurnOrder(bs, block)
    })
  }
  const canAutoApproveRequest = (request: ApprovalRequest) => (
    Boolean(request.turnId && autoApprovedTurns.current.has(request.turnId))
  )
  const autoApproveRequest = (request: ApprovalRequest) => {
    approvalRequests.current.set(request.key, { ...request, status: 'approvedAll' })
    setApprovalStatus(request.key, 'approvedAll')
    if (request.turnId) {
      upsertTurnBlock(request.turnId, `turn-${request.turnId}`, request.startedAt)
      const activityId = ensureActivity(request.turnId, `approval-${request.key}`, {
        kind: 'tool',
        title: 'Auto-approved workspace step',
        detail: request.title,
        actionKind: 'tool'
      })
      updateActivity(request.turnId, activityId, {
        status: 'done',
        endedAt: Date.now(),
        title: 'Auto-approved workspace step',
        detail: request.title
      })
    }
    void sendRpcResult(request.id, approvalResponsePayload(request, 'approveAll'))
      .then((ok) => {
        if (!ok) throw new Error('Codex process is not running')
      })
      .catch((err: any) => {
        approvalRequests.current.delete(request.key)
        if (request.turnId) {
          updateActivity(request.turnId, `a-approval-${request.key}`, {
            status: 'failed',
            endedAt: Date.now(),
            title: 'Auto-approval failed',
            detail: err?.message ?? String(err)
          })
        }
        upsertApprovalBlock({ ...request, status: 'pending' })
        toast('error', err?.message ?? String(err))
      })
  }
  const autoApprovePendingRequestsForTurn = (turnId: string, exceptKey: string) => {
    for (const request of Array.from(approvalRequests.current.values())) {
      if (request.key === exceptKey || request.turnId !== turnId || request.status !== 'pending') continue
      autoApproveRequest(request)
    }
  }
  const resolveApprovalRequest = (requestId: JsonRpcId) => {
    const key = rpcKey(requestId)
    const request = approvalRequests.current.get(key)
    if (!request || request.status === 'approved' || request.status === 'approvedAll' || request.status === 'denied') return
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
    if (canAutoApproveRequest(request)) {
      autoApproveRequest(request)
      return
    }
    upsertApprovalBlock(request)
    scrollToLatest('smooth')
  }
  const respondApproval = async (request: ApprovalRequest, mode: ApprovalDecisionMode) => {
    if (request.status !== 'pending') return
    setApprovalStatus(request.key, 'sending')
    if (mode === 'approveAll' && request.turnId) autoApprovedTurns.current.add(request.turnId)
    try {
      const ok = await sendRpcResult(request.id, approvalResponsePayload(request, mode))
      if (!ok) throw new Error('Codex process is not running')
      const status = approvalStatusForDecision(mode)
      setApprovalStatus(request.key, status)
      if (mode === 'approveAll' && request.turnId) autoApprovePendingRequestsForTurn(request.turnId, request.key)
      if (request.turnId) {
        updateActivity(request.turnId, `a-approval-${request.key}`, {
          status: mode === 'deny' ? 'failed' : 'done',
          endedAt: Date.now(),
          title: mode === 'approveAll' ? 'Approval granted for this session' : mode === 'approve' ? 'Approval granted' : 'Approval denied',
          detail: request.title
        })
      }
    } catch (err: any) {
      if (mode === 'approveAll' && request.turnId) autoApprovedTurns.current.delete(request.turnId)
      setApprovalStatus(request.key, 'pending')
      toast('error', err?.message ?? String(err))
    }
  }

  const noteCompletedTurnWork = (turnId: string, kind: CompletedTurnWorkKind) => {
    if (!turnId) return
    const current = completedWorkByTurn.current.get(turnId) ?? new Set<CompletedTurnWorkKind>()
    current.add(kind)
    completedWorkByTurn.current.set(turnId, current)
  }

  const settleTurnRecovery = (turnId: string) => {
    clearTurnRecoveryTimers(turnId)
    completedWorkByTurn.current.delete(turnId)
    interruptingTurns.current.delete(turnId)
    autoApprovedTurns.current.delete(turnId)
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
      status: 'interrupted',
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

  useEffect(() => { runtimeRef.current = runtime }, [runtime])
  useEffect(() => { threadRef.current = thread }, [thread])
  useEffect(() => { workspaceFilesRef.current = workspaceFiles }, [workspaceFiles])
  useEffect(() => { activeSharedWorkspaceRef.current = activeSharedWorkspace }, [activeSharedWorkspace])
  useEffect(() => { activeSharedSessionRef.current = activeSharedSession }, [activeSharedSession])
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
            const turnStatus = params?.turn?.status
            const status = turnStatus === 'interrupted' ? 'interrupted' : turnStatus === 'failed' ? 'failed' : 'completed'
            return { ...t, endedAt: Date.now(), collapsed: false, status, activities: acts }
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
              status: statusType === 'interrupted' ? 'interrupted' : 'completed',
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
              status: 'completed',
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
              status: 'failed',
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
      if (buf.current.length > MAX_STDOUT_BUFFER_CHARS) {
        // Drop the leading garbage *up to* the next newline so the next parse
        // starts on a clean line boundary. Slicing the raw tail used to leave
        // a half-line at the head, which then failed JSON.parse silently and
        // dropped a real frame on the floor.
        const safeNl = buf.current.indexOf('\n', buf.current.length - MAX_STDOUT_BUFFER_CHARS)
        buf.current = safeNl === -1 ? '' : buf.current.slice(safeNl + 1)
      }
      let nl: number
      while ((nl = buf.current.indexOf('\n')) !== -1) {
        const line = buf.current.slice(0, nl).trim()
        buf.current = buf.current.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method && msg.id !== undefined) {
            handleServerRequest(msg.id, msg.method, msg.params)
          } else if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)!.resolve(msg)
            pending.delete(msg.id)
            if (msg.error && shouldAutoToastRpcError(msg.error.message)) toast('error', msg.error.message)
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
      rejectPendingRequests('Codex process exited before replying')
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
    const offEnterpriseDeviceCode = window.zspark.onEnterpriseDeviceCode((payload) => {
      setEnterpriseDeviceCode(payload)
      if (payload.userCode) toast('info', `Enter code ${payload.userCode} to finish Entra sign-in`)
    })
    handshake()
    refreshEnterprise()
    return () => {
      if (typeof offStdout === 'function') offStdout()
      if (typeof offStderr === 'function') offStderr()
      if (typeof offExit === 'function') offExit()
      if (typeof offSpawned === 'function') offSpawned()
      if (typeof offEnterpriseDeviceCode === 'function') offEnterpriseDeviceCode()
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
    const serialized = serializePersistedActivityBlocks(blocks)
    if (!serialized) return
    const key = `${thread}:${serialized}`
    if (key === lastPersistedActivityKey.current) return
    savePersistedActivityBlocks(thread, serialized)
    lastPersistedActivityKey.current = key
  }, [blocks, thread])
  useEffect(() => {
    if (!activeSharedWorkspace || !activeSharedSession || !blocks.length) return
    if (sharedSyncTimer.current) window.clearTimeout(sharedSyncTimer.current)
    sharedSyncTimer.current = window.setTimeout(() => {
      const title = titleFromBlocks(blocks)
      const localThreadId = threadRef.current
      const snapshot = { version: 1, blocks, localThreadId, title, updatedAt: Date.now() }
      const snapshotKey = JSON.stringify({ activeSharedWorkspace, activeSharedSession, localThreadId, title, blocks })
      if (snapshotKey === lastSharedSnapshotKey.current) return
      inFlightSharedSnapshotKey.current = snapshotKey
      void window.zspark.enterpriseUpdateSession(activeSharedWorkspace, activeSharedSession, {
        title,
        localThreadId,
        baseRevision: activeSharedSnapshotRevision.current,
        snapshot
      }).then((result) => {
        if (!result.ok) {
          if (result.status === 409) {
            setEnterpriseError('This shared session changed on another device. Reopen it before sending more changes.')
            toast('warn', 'Shared session changed elsewhere. Reopen it before continuing.')
          }
          return
        }
        activeSharedSnapshotRevision.current = result.snapshotRevision ?? activeSharedSnapshotRevision.current
        // Only commit dedup key if no newer snapshot was scheduled while we
        // were waiting on the network — otherwise we'd briefly think the
        // newer state had already been sent.
        if (inFlightSharedSnapshotKey.current === snapshotKey) {
          lastSharedSnapshotKey.current = snapshotKey
        }
        setSharedSessions((prev) => prev.map((session) => (
          session.id === activeSharedSession
            ? { ...session, ...(result.session ?? {}), title, local_thread_id: localThreadId }
            : session
        )))
      })
    }, 800)
    return () => {
      if (sharedSyncTimer.current) window.clearTimeout(sharedSyncTimer.current)
    }
  }, [blocks, activeSharedWorkspace, activeSharedSession, thread])
  useEffect(() => {
    for (const block of blocks) {
      if (block.type === 'agent') void reconcileAgentArtifactClaims(block)
    }
  }, [blocks, runtime.cwd, runtime.workspaceRoot])
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
        if (activeSharedWorkspace) {
          const result = await window.zspark.enterpriseSessions(activeSharedWorkspace)
          if (!cancelled && result.ok) setSharedSessions(result.sessions ?? [])
          return
        }
        const r = await send('thread/list', { limit: 50 })
        if (!cancelled) setThreads(r.result?.data ?? [])
      } catch {}
    }
    refresh()
    return () => { cancelled = true }
  }, [ready, thread, activeSharedWorkspace, activeSharedSession])

  useEffect(() => {
    if (!ready) return
    refreshSkills().catch(() => {})
  }, [ready])

  const startLocalChat = async () => {
    if (!ready) return false
    const seq = switchThreadSeq.current + 1
    switchThreadSeq.current = seq
    stickToBottom.current = true
    setShowJumpToLatest(false)
    resetLiveTurnState()
    setBlocks([])
    try {
      const t = await send('thread/start', userApprovalParams())
      if (seq !== switchThreadSeq.current) return false
      applyThreadRuntime(t.result)
      setThread(t.result?.thread?.id ?? null)
      return true
    } catch (e: any) {
      if (seq === switchThreadSeq.current) toast('error', errorMessage(e))
      return false
    }
  }
  const switchLocalThread = async (id: string, options: { startNewOnMissingRollout?: boolean } = {}) => {
    if (!ready) return false
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
      return true
    } catch (e: any) {
      const message = errorMessage(e)
      if (isMissingRolloutError(message)) {
        if (lastLocalThreadRef.current === id) lastLocalThreadRef.current = null
        if (options.startNewOnMissingRollout && seq === switchThreadSeq.current) {
          await startLocalChat()
          return false
        }
      }
      if (seq === switchThreadSeq.current) toast('error', message)
      return false
    }
  }
  const createSharedSession = async () => {
    const workspaceId = activeSharedWorkspaceRef.current
    if (!ready || !workspaceId) return null
    const seq = switchThreadSeq.current + 1
    switchThreadSeq.current = seq
    stickToBottom.current = true
    setShowJumpToLatest(false)
    resetLiveTurnState()
    setBlocks([])
    setWorkspaceFiles([])
    try {
      const t = await send('thread/start', userApprovalParams())
      if (seq !== switchThreadSeq.current) return null
      if (t.error) throw new Error(t.error.message)
      applyThreadRuntime(t.result)
      const localThreadId = t.result?.thread?.id ?? null
      setThread(localThreadId)
      const result = await window.zspark.enterpriseCreateSession(workspaceId, {
        title: 'New shared chat',
        localThreadId,
        snapshot: { version: 1, blocks: [], localThreadId, title: 'New shared chat', updatedAt: Date.now() }
      })
      if (!result.ok || !result.session) throw new Error(result.error ?? 'Could not create shared session')
      activeSharedSessionRef.current = result.session.id
      activeSharedSnapshotRevision.current = result.snapshotRevision ?? null
      lastSharedSnapshotKey.current = JSON.stringify({ activeSharedWorkspace: workspaceId, activeSharedSession: result.session.id, localThreadId, title: 'New shared chat', blocks: [] })
      setActiveSharedSession(result.session.id)
      setSharedSessions((prev) => [result.session!, ...prev.filter((session) => session.id !== result.session!.id)])
      return { sessionId: result.session.id, localThreadId }
    } catch (e: any) {
      if (seq === switchThreadSeq.current) toast('error', e?.message ?? String(e))
      return null
    }
  }
  const switchSharedSession = async (id: string) => {
    const workspaceId = activeSharedWorkspaceRef.current
    if (!ready || !workspaceId) return
    const seq = switchThreadSeq.current + 1
    switchThreadSeq.current = seq
    stickToBottom.current = true
    setShowJumpToLatest(false)
    resetLiveTurnState()
    setBlocks([])
    setWorkspaceFiles([])
    try {
      const result = await window.zspark.enterpriseReadSession(workspaceId, id)
      if (seq !== switchThreadSeq.current) return
      if (!result.ok || !result.session) throw new Error(result.error ?? 'Could not open shared session')
      activeSharedSessionRef.current = id
      activeSharedSnapshotRevision.current = result.snapshot?.revision ?? null
      lastSharedSnapshotKey.current = ''
      setActiveSharedSession(id)
      setPanel(null)
      const snapshotBlocks = blocksFromSharedSnapshot(result.snapshot)
      const sharedArtifactFiles = await fetchSharedArtifactFiles(workspaceId, id)
      if (sharedArtifactFiles.length) upsertWorkspaceFiles(sharedArtifactFiles)
      const localThreadId = result.session.local_thread_id ?? result.snapshot?.localThreadId ?? null
      let replayed = false
      if (localThreadId) {
        try {
          const t = await send('thread/resume', { threadId: localThreadId, ...userApprovalParams() })
          if (seq !== switchThreadSeq.current) return
          if (t.error) throw new Error(t.error.message)
          applyThreadRuntime(t.result)
          setThread(t.result?.thread?.id ?? localThreadId)
          let threadForReplay = t.result?.thread
          if (!Array.isArray(threadForReplay?.turns) || threadForReplay.turns.length === 0) {
            const read = await send('thread/read', { threadId: localThreadId, includeTurns: true })
            if (seq !== switchThreadSeq.current) return
            if (!read.error) threadForReplay = read.result?.thread ?? threadForReplay
          }
          const replay = blocksFromThreadTurns(threadForReplay?.turns ?? [], runtimeRef.current.cwd ?? runtimeRef.current.workspaceRoot)
          const restoredBlocks = mergePersistedActivityBlocks(replay.blocks, loadPersistedActivityBlocks(localThreadId))
          if (replay.files.length) upsertWorkspaceFiles(replay.files)
          if (restoredBlocks.length) {
            setBlocks(withSharedArtifactBlock(restoredBlocks, sharedArtifactFiles, id))
            replayed = true
          }
        } catch {
          // The shared transcript can still be viewed even if this machine
          // does not have the original local Codex thread.
        }
      }
      if (!replayed) {
        const t = await send('thread/start', userApprovalParams())
        if (seq !== switchThreadSeq.current) return
        if (t.error) throw new Error(t.error.message)
        applyThreadRuntime(t.result)
        const nextThreadId = t.result?.thread?.id ?? null
        setThread(nextThreadId)
        await window.zspark.enterpriseUpdateSession(workspaceId, id, {
          localThreadId: nextThreadId,
          baseRevision: activeSharedSnapshotRevision.current,
          snapshot: { version: 1, blocks: snapshotBlocks, localThreadId: nextThreadId, title: result.session.title ?? undefined, updatedAt: Date.now() }
        }).then((update) => {
          if (!update.ok) throw new Error(update.error ?? 'Could not bind shared session to this runtime')
          activeSharedSnapshotRevision.current = update.snapshotRevision ?? activeSharedSnapshotRevision.current
        })
        setSharedSessions((prev) => prev.map((session) => (
          session.id === id ? { ...session, local_thread_id: nextThreadId } : session
        )))
        setBlocks(withSharedArtifactBlock(snapshotBlocks, sharedArtifactFiles, id))
        if (snapshotBlocks.length) toast('info', 'Opened shared transcript with a new local runtime context.')
      }
    } catch (e: any) {
      if (seq === switchThreadSeq.current) toast('error', e?.message ?? String(e))
    }
  }
  const newChat = async () => {
    if (activeSharedWorkspaceRef.current) {
      await createSharedSession()
      return
    }
    await startLocalChat()
  }
  const switchThread = async (id: string) => {
    if (activeSharedWorkspaceRef.current) {
      await switchSharedSession(id)
      return
    }
    await switchLocalThread(id)
  }
  const deleteThread = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!ready) return
    if (!confirm('Delete this chat? This cannot be undone.')) return
    try {
      if (activeSharedWorkspaceRef.current) {
        const workspaceId = activeSharedWorkspaceRef.current
        const result = await window.zspark.enterpriseDeleteSession(workspaceId, id)
        if (!result.ok && result.status !== 204) throw new Error(result.error ?? 'Could not delete shared session')
        setSharedSessions((p) => p.filter((session) => session.id !== id))
        if (activeSharedSessionRef.current === id) {
          switchThreadSeq.current += 1
          resetLiveTurnState()
          activeSharedSessionRef.current = null
          activeSharedSnapshotRevision.current = null
          setActiveSharedSession(null)
          setThread(null)
          setBlocks([])
          setWorkspaceFiles([])
        }
        return
      }
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
      const result = await window.zspark.openSkillPath(path)
      if (!result.ok) toast('error', result.error ?? 'Could not open skill file')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const openFilePath = async (path?: string) => {
    if (!path) return
    if (isSharedArtifactPath(path)) {
      toast('info', 'Download the shared artifact first, then open it locally.')
      return
    }
    try {
      const result = await window.zspark.openPath(path)
      if (!result.ok) toast('error', result.error ?? 'Could not open file')
    } catch (err: any) {
      toast('error', err?.message ?? String(err))
    }
  }

  const revealFilePath = async (path?: string) => {
    if (!path) return
    if (isSharedArtifactPath(path)) {
      toast('info', 'Shared artifacts live on the workspace server. Download one to reveal it locally.')
      return
    }
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

  const downloadWorkspaceFile = async (file: WorkspaceFile) => {
    if (file.sharedArtifact) {
      const { workspaceId, sessionId, artifactId } = file.sharedArtifact
      try {
        const result = await window.zspark.enterpriseDownloadArtifactToCache(workspaceId, sessionId, artifactId, file.name)
        if (result.ok) {
          toast('info', `Downloaded to ${shortPath(result.path)}`)
        } else {
          toast('error', result.error ?? 'Could not download shared artifact')
        }
      } catch (err: any) {
        toast('error', err?.message ?? String(err))
      }
      return
    }
    await downloadFilePath(file.path)
  }

  const openWorkspaceFile = async (file: WorkspaceFile) => {
    if (file.sharedArtifact) {
      const { workspaceId, sessionId, artifactId } = file.sharedArtifact
      try {
        const result = await window.zspark.enterpriseDownloadArtifactToCache(workspaceId, sessionId, artifactId, file.name)
        if (result.ok && result.path) {
          await openFilePath(result.path)
        } else {
          toast('error', result.error ?? 'Could not open shared artifact')
        }
      } catch (err: any) {
        toast('error', err?.message ?? String(err))
      }
      return
    }
    await openFilePath(file.path)
  }

  const revealWorkspaceFile = async (file: WorkspaceFile) => {
    if (file.sharedArtifact) {
      toast('info', 'Shared artifacts are stored on the workspace server. Download it to reveal a local copy.')
      return
    }
    await revealFilePath(file.path)
  }

  const downloadArtifactPath = async (path?: string) => {
    const sharedFile = findSharedWorkspaceFileForPath(workspaceFilesRef.current, path)
    if (sharedFile) {
      await downloadWorkspaceFile(sharedFile)
      return
    }
    await downloadFilePath(path)
  }

  const openArtifactPath = async (path?: string) => {
    const sharedFile = findSharedWorkspaceFileForPath(workspaceFilesRef.current, path)
    if (sharedFile) {
      await openWorkspaceFile(sharedFile)
      return
    }
    await openFilePath(path)
  }

  const openSharedArtifactFolder = async () => {
    try {
      const result = await window.zspark.enterpriseOpenArtifactCache(
        activeSharedWorkspaceRef.current ?? undefined,
        activeSharedSessionRef.current ?? undefined
      )
      if (!result.ok) toast('error', result.error ?? 'Could not open shared artifact folder')
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
    if (p === 'files') {
      if (activeSharedWorkspaceRef.current) await refreshSharedArtifactsForActiveSession(true)
      return
    }
    if (!ready) return
    if (p === 'history' || p === 'search') {
      try {
        if (activeSharedWorkspaceRef.current) {
          await refreshSharedSessions(activeSharedWorkspaceRef.current, true)
          return
        }
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
    let targetThreadId = thread
    if (activeSharedWorkspaceRef.current && !activeSharedSessionRef.current) {
      const created = await createSharedSession()
      if (!created?.localThreadId) return
      targetThreadId = created.localThreadId
    }
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
      const res = await send('turn/start', { threadId: targetThreadId, input: inputItems, ...userApprovalParams() })
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
  const artifactRuntimeStatus = runtime.workspaceRuntime?.available
    ? (runtime.workspaceRuntime.pythonAvailable ? 'runtime ready' : 'node ready, python missing')
    : 'runtime missing'
  const streamingAgentId = currentTurn.current ? agentForTurn.current.get(currentTurn.current.turnId) : undefined
  const activeSharedWorkspaceName = sharedWorkspaces.find((workspace) => workspace.id === activeSharedWorkspace)?.name
  const activeSharedSessionTitle = sharedSessions.find((session) => session.id === activeSharedSession)?.title
  const visibleThreads = activeSharedWorkspace ? sharedSessions.map(sharedSessionToThread) : threads
  const activeThreadId = activeSharedWorkspace ? activeSharedSession : thread
  const sharedWorkspaceFiles = workspaceFiles.filter((file) => file.sharedArtifact)
  const visibleWorkspaceFiles = activeSharedWorkspace ? sharedWorkspaceFiles : workspaceFiles

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
        {activeSharedWorkspace && (
          <button className="local-workspace-btn" onClick={exitSharedWorkspace}>
            <IconProject /><span>Local workspace</span>
          </button>
        )}
        <div className="shared-sidebar">
          <div className="shared-sidebar-head">
            <span>Shared workspaces</span>
            <button onClick={() => openPanel('shared')} title="Manage shared workspaces"><IconShield /></button>
          </div>
          {!enterprise?.signedIn ? (
            <button className="shared-signin" onClick={signInEnterprise} disabled={enterpriseBusy}>
              {enterpriseBusy ? 'Connecting...' : 'Sign in with Entra'}
            </button>
          ) : sharedWorkspaces.length === 0 ? (
            <>
              <button className="shared-signin" onClick={createSharedWorkspace} disabled={enterpriseBusy}>
                {enterpriseBusy ? 'Creating...' : 'Create shared workspace'}
              </button>
              {enterpriseError && <div className="shared-sidebar-error">{enterpriseError}</div>}
            </>
          ) : (
            <div className="shared-workspace-list">
              {sharedWorkspaces.slice(0, 5).map((workspace) => (
                <button
                  key={workspace.id}
                  className={activeSharedWorkspace === workspace.id ? 'active' : ''}
                  onClick={() => selectSharedWorkspace(workspace.id)}
                  title={workspace.name}
                >
                  <IconProject />
                  <span>{workspace.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <h3>{activeSharedWorkspace ? 'Shared sessions' : 'Recent'}</h3>
        {visibleThreads.slice(0, 8).map((t) => (
          <div key={t.id} className={`nav-item nav-item-thread${activeThreadId === t.id ? ' active' : ''}`} onClick={() => switchThread(t.id)}>
            <IconProject />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{displayThreadPreview(t)}</span>
            <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete chat" title="Delete chat"><IconClose /></button>
          </div>
        ))}
        {visibleThreads.length === 0 && <div className="nav-item" onClick={() => openPanel('history')} style={{ color: '#a1a1aa' }}><IconProject /><span>{activeSharedWorkspace ? 'No shared sessions yet' : 'No chats yet'}</span></div>}
      </aside>

      <main className="chat">
        <div className="chat-header">
          <div className="left workspace-title">
            <span>{activeSharedWorkspaceName ? 'Shared workspace' : 'Workspace'}</span>
            <small title={activeSharedWorkspaceName ? enterprise?.config.serverUrl : runtimeCwd}>
              {activeSharedWorkspaceName ? [activeSharedWorkspaceName, activeSharedSessionTitle].filter(Boolean).join(' / ') : shortPath(runtimeCwd)}
            </small>
          </div>
          <div className="right">
            {streaming && <button className="header-btn danger" onClick={stopTurn}><IconClose /> Stop</button>}
            {activeSharedWorkspace && <button className="header-btn" onClick={() => openPanel('files')} disabled={!activeSharedSession}><IconFile /> Files</button>}
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
                        workspaceFiles={workspaceFiles}
                        onDownload={downloadArtifactPath}
                        onOpen={openArtifactPath}
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
                            <button title={file.path} onClick={() => openWorkspaceFile(file)} disabled={file.status === 'missing'}>{file.name}</button>
                            <small title={file.path}>{file.sharedArtifact ? 'Shared workspace artifact' : shortPath(file.path)}</small>
                          </div>
                          <div className="artifact-actions">
                            <button className="primary" onClick={() => downloadWorkspaceFile(file)} disabled={file.status === 'missing'}>Download</button>
                            <button onClick={() => openWorkspaceFile(file)} disabled={file.status === 'missing'}>{file.sharedArtifact ? 'Save' : 'Open'}</button>
                            <button onClick={() => revealWorkspaceFile(file)} disabled={file.status === 'missing' || Boolean(file.sharedArtifact)}>Reveal</button>
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
                    onDecision={(request, mode) => void respondApproval(request, mode)}
                  />
                )
              }
              const running = !b.endedAt
              const interrupted = b.status === 'interrupted'
              const failed = b.status === 'failed' || b.activities.some((a) => a.status === 'failed')
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
                          <span className="head-title">{running ? 'Working' : interrupted ? 'Stopped' : failed ? 'Needs attention' : 'Completed'}</span>
                          <span className="head-meta">Activity log · <ActivityDuration startedAt={b.startedAt} endedAt={b.endedAt} /> · {stepsLabel}</span>
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
          <div className="kv"><span className="k">{activeSharedWorkspace ? 'Shared' : 'Thread'}</span><span className="v">{activeSharedWorkspace ? (activeSharedSession ? activeSharedSession.slice(0, 8) : '—') : (thread ? thread.slice(0, 8) : '—')}</span></div>
          {activeSharedWorkspace && <div className="kv"><span className="k">Runtime</span><span className="v">{thread ? thread.slice(0, 8) : '—'}</span></div>}
          <div className="kv"><span className="k">Status</span><span className="v"><span className={`pill ${ready ? '' : 'off'}`}>{ready ? 'live' : 'offline'}</span></span></div>
          <div className="kv"><span className="k">Skills</span><span className="v">{usableSkillCount} ready</span></div>
        </div>
        <div className="right-section">
          <h4>Enterprise</h4>
          <div className="kv"><span className="k">Shared</span><span className="v">{enterprise?.signedIn ? 'connected' : 'not signed in'}</span></div>
          <div className="kv"><span className="k">Account</span><span className="v" title={enterprise?.account?.username}>{enterprise?.account?.username ?? '—'}</span></div>
          <div className="kv"><span className="k">Workspaces</span><span className="v">{sharedWorkspaces.length}</span></div>
          {activeSharedWorkspace && <div className="kv"><span className="k">Sessions</span><span className="v">{sharedSessions.length}</span></div>}
          <div className="file-actions">
            {enterprise?.signedIn ? (
              <>
                <button onClick={() => void refreshEnterprise(true)} disabled={enterpriseBusy}>Refresh</button>
                {activeSharedWorkspace && <button onClick={exitSharedWorkspace} disabled={enterpriseBusy}>Local</button>}
                <button onClick={signOutEnterprise} disabled={enterpriseBusy}>Sign out</button>
              </>
            ) : (
              <button onClick={signInEnterprise} disabled={enterpriseBusy}>{enterpriseBusy ? 'Connecting...' : 'Sign in'}</button>
            )}
          </div>
          {enterpriseDeviceCode?.userCode && (
            <div className="device-code">
              <strong>{enterpriseDeviceCode.userCode}</strong>
              <span>Use this code in the browser window to finish Entra sign-in.</span>
            </div>
          )}
        </div>
        <div className="right-section">
          <h4>Runtime</h4>
          <div className="kv"><span className="k">CWD</span><span className="v" title={runtimeCwd}>{shortPath(runtimeCwd)}</span></div>
          <div className="kv"><span className="k">Model</span><span className="v">{runtimeProvider ?? '—'}</span></div>
          <div className="kv"><span className="k">Provider</span><span className="v">{runtimeProviderName ?? '—'}</span></div>
          <div className="kv"><span className="k">Wire API</span><span className="v">{runtime.provider?.wireApi ?? 'responses'}</span></div>
          <div className="kv"><span className="k">Artifacts</span><span className="v">{artifactRuntimeStatus}</span></div>
          <div className="kv"><span className="k">Sandbox</span><span className="v">{formatSandboxPolicy(runtime.sandbox, runtime.permissionProfile)}</span></div>
          <div className="kv"><span className="k">Approval</span><span className="v">{formatApprovalPolicy(runtime.approvalPolicy)}</span></div>
          {runtime.activePermissionProfile?.id && <div className="kv"><span className="k">Profile</span><span className="v">{runtime.activePermissionProfile.id}</span></div>}
        </div>
        <div className="right-section">
          <h4>{activeSharedWorkspace ? 'Shared artifacts' : 'Files'}</h4>
          <div className="file-actions">
            <button onClick={() => activeSharedWorkspace ? refreshSharedArtifactsForActiveSession(true) : revealFilePath(runtime.attachmentDir)} disabled={activeSharedWorkspace ? !activeSharedSession : !runtime.attachmentDir}>
              {activeSharedWorkspace ? 'Refresh shared' : 'Attachments'}
            </button>
            <button onClick={() => revealFilePath(runtime.workspaceRoot)} disabled={!runtime.workspaceRoot} title={activeSharedWorkspace ? 'Opens this machine’s local runtime folder, not the shared server files.' : undefined}>
              {activeSharedWorkspace ? 'Local runtime' : 'Workspace'}
            </button>
            {activeSharedWorkspace && (
              <button onClick={openSharedArtifactFolder} disabled={!activeSharedSession}>
                Open downloads
              </button>
            )}
            {activeSharedWorkspace && (
              <button onClick={() => openPanel('files')} disabled={!activeSharedSession}>
                Artifacts
              </button>
            )}
          </div>
          {visibleWorkspaceFiles.length === 0 ? (
            <div className="right-empty">{activeSharedWorkspace ? 'No shared artifacts yet.' : 'No attached or changed files yet.'}</div>
          ) : (
            <div className="file-list">
              {visibleWorkspaceFiles.slice(0, 8).map((file) => (
                <div className="file-row" key={file.path}>
                  <div className="file-row-main">
                    <span className={`file-status file-status-${file.status}`}>{file.status}</span>
                    <button title={file.path} onClick={() => openWorkspaceFile(file)}>{file.name}</button>
                  </div>
                  <button className="file-reveal" onClick={() => file.sharedArtifact ? downloadWorkspaceFile(file) : revealWorkspaceFile(file)}>{file.sharedArtifact ? 'Download' : 'Reveal'}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {panel === 'search' && (
        <Drawer title={activeSharedWorkspace ? 'Search shared sessions' : 'Search threads'} onClose={() => setPanel(null)}>
          <input className="drawer-search" placeholder="Filter by preview…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <div className="drawer-list">
            {visibleThreads.filter((t) => !searchQuery || displayThreadPreview(t).toLowerCase().includes(searchQuery.toLowerCase())).map((t) => (
              <div key={t.id} className="drawer-row">
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => switchThread(t.id)}>
                  <div className="drawer-row-t">{displayThreadPreview(t)}</div>
                  <div className="drawer-row-d">{t.id.slice(0, 8)} · {t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : ''}</div>
                </div>
                <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete"><IconClose /></button>
              </div>
            ))}
            {visibleThreads.length === 0 && <div className="drawer-empty">{activeSharedWorkspace ? 'No shared sessions yet. Start a new chat in this workspace.' : 'No threads yet. Start a new chat to get going.'}</div>}
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

      {panel === 'files' && (
        <Drawer title={activeSharedWorkspace ? 'Shared artifacts' : 'Workspace files'} onClose={() => setPanel(null)}>
          <div className="shared-panel">
            <div className="file-actions">
              <button onClick={() => activeSharedWorkspace ? refreshSharedArtifactsForActiveSession(true) : revealFilePath(runtime.attachmentDir)} disabled={activeSharedWorkspace ? !activeSharedSession : !runtime.attachmentDir}>
                {activeSharedWorkspace ? 'Refresh shared' : 'Attachments'}
              </button>
              <button onClick={() => revealFilePath(runtime.workspaceRoot)} disabled={!runtime.workspaceRoot}>
                Local runtime
              </button>
              {activeSharedWorkspace && (
                <button onClick={openSharedArtifactFolder} disabled={!activeSharedSession}>
                  Open downloads
                </button>
              )}
            </div>
            {visibleWorkspaceFiles.length === 0 ? (
              <div className="drawer-empty">{activeSharedWorkspace ? 'No shared artifacts for this session yet.' : 'No attached or changed files yet.'}</div>
            ) : (
              <div className="artifact-list">
                {visibleWorkspaceFiles.map((file) => (
                  <div className="artifact-row" key={file.path}>
                    <div className="artifact-file">
                      <span className={`file-status file-status-${file.status}`}>{file.status}</span>
                      <button title={file.path} onClick={() => openWorkspaceFile(file)} disabled={file.status === 'missing'}>{file.name}</button>
                      <small title={file.path}>{file.sharedArtifact ? 'Shared workspace artifact' : shortPath(file.path)}</small>
                    </div>
                    <div className="artifact-actions">
                      <button className="primary" onClick={() => downloadWorkspaceFile(file)} disabled={file.status === 'missing'}>Download</button>
                      <button onClick={() => openWorkspaceFile(file)} disabled={file.status === 'missing'}>{file.sharedArtifact ? 'Save' : 'Open'}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Drawer>
      )}

      {panel === 'shared' && (
        <Drawer title="Shared workspaces" onClose={() => setPanel(null)}>
          <div className="shared-panel">
            <div className={`shared-status ${enterprise?.signedIn ? 'connected' : ''}`}>
              <IconShield />
              <div>
                <strong>{enterprise?.signedIn ? 'Connected through Entra ID' : 'Not signed in'}</strong>
                <span>{enterprise?.signedIn ? (enterprise.account?.username ?? 'Enterprise account connected') : 'Sign in to see server-side workspaces allowed by ACL.'}</span>
              </div>
            </div>
            <div className="shared-actions">
              {enterprise?.signedIn ? (
                <>
                  <button onClick={() => void refreshEnterprise(true)} disabled={enterpriseBusy}>Refresh</button>
                  <button onClick={createSharedWorkspace} disabled={enterpriseBusy}>New shared workspace</button>
                  {activeSharedWorkspace && <button className="ghost" onClick={exitSharedWorkspace} disabled={enterpriseBusy}>Back to local</button>}
                  <button className="ghost" onClick={signOutEnterprise} disabled={enterpriseBusy}>Sign out</button>
                </>
              ) : (
                <button onClick={signInEnterprise} disabled={enterpriseBusy}>{enterpriseBusy ? 'Connecting...' : 'Sign in with Entra ID'}</button>
              )}
            </div>
            {enterpriseDeviceCode?.userCode && (
              <div className="device-code large">
                <strong>{enterpriseDeviceCode.userCode}</strong>
                <span>{enterpriseDeviceCode.message ?? 'Enter this code in the Microsoft sign-in page.'}</span>
              </div>
            )}
            {enterpriseError && <div className="enterprise-error">{enterpriseError}</div>}
            <div className="workspace-server-card">
              <div><span>Server</span><strong title={enterprise?.config.serverUrl}>{enterprise?.config.serverUrl ?? '—'}</strong></div>
              <div><span>Tenant</span><strong>{enterprise?.config.tenantId ?? '—'}</strong></div>
            </div>
            <div className="drawer-list">
              {sharedWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className={`drawer-row ${activeSharedWorkspace === workspace.id ? 'selected' : ''}`}
                  onClick={() => selectSharedWorkspace(workspace.id)}
                >
                  <IconProject />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="drawer-row-t">{workspace.name}</div>
                    <div className="drawer-row-d">{workspace.id}</div>
                  </div>
                </div>
              ))}
              {enterprise?.signedIn && sharedWorkspaces.length === 0 && <div className="drawer-empty">No shared workspaces available for this account yet.</div>}
              {!enterprise?.signedIn && <div className="drawer-empty">Shared workspaces are separate from local Recent chats and require Entra access.</div>}
            </div>
          </div>
        </Drawer>
      )}

      {panel === 'history' && (
        <Drawer title={activeSharedWorkspace ? 'Shared session history' : 'Chat history'} onClose={() => setPanel(null)}>
          <div className="drawer-list">
            {visibleThreads.map((t) => (
              <div key={t.id} className="drawer-row">
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => switchThread(t.id)}>
                  <div className="drawer-row-t">{displayThreadPreview(t)}</div>
                  <div className="drawer-row-d">{t.id.slice(0, 8)}</div>
                </div>
                <button className="row-x" onClick={(e) => deleteThread(t.id, e)} aria-label="Delete"><IconClose /></button>
              </div>
            ))}
            {visibleThreads.length === 0 && <div className="drawer-empty">{activeSharedWorkspace ? 'No shared sessions.' : 'No history.'}</div>}
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
