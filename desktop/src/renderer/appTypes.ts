/**
 * Shared type definitions for the renderer.
 *
 * Extracted from App.tsx so individual feature modules (markdown view, IPC
 * client, helpers, …) can compile in isolation. Pure types only — no React,
 * no module state.
 */

export type JsonRpcId = number | string

export interface Pending {
  resolve: (msg: any) => void
  reject: (err: any) => void
}

export type ActivityKind = 'reasoning' | 'command' | 'file' | 'tool' | 'web' | 'memory'
export type ActivityActionKind = 'read' | 'write' | 'list' | 'search' | 'run' | 'build' | 'verify' | 'tool' | 'file'
export type TurnBlockStatus = 'running' | 'completed' | 'interrupted' | 'failed'

export interface Activity {
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

export type ActivityInfo = {
  title: string
  detail?: string
  actionKind: ActivityActionKind
  target?: string
}

export type ApprovalKind = 'command' | 'fileChange' | 'permissions'
export type ApprovalDecisionMode = 'approve' | 'approveAll' | 'deny'
export type ApprovalStatus = 'pending' | 'sending' | 'approved' | 'approvedAll' | 'denied' | 'resolved'

export interface ApprovalRequest {
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

export interface MemoryCitationEntry {
  path: string
  lineStart?: number
  lineEnd?: number
  note?: string
}

export interface MemoryCitation {
  entries?: MemoryCitationEntry[]
  threadIds?: string[]
}

export type TurnInputItem =
  | { type: 'text'; text: string; textElements?: any[]; text_elements?: any[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export interface WorkspaceFile {
  id: string
  name: string
  path: string
  source: 'attachment' | 'change'
  status: 'attached' | 'created' | 'modified' | 'deleted' | 'missing'
  detail?: string
  updatedAt: number
  sharedArtifact?: {
    workspaceId: string
    sessionId: string
    artifactId: string
    sizeBytes?: number
  }
}

export type Block =
  | { type: 'user'; id: string; text: string; turnId?: string; input?: TurnInputItem[] }
  | { type: 'agent'; id: string; text: string; turnId?: string; memoryCitation?: MemoryCitation | null }
  | { type: 'files'; id: string; turnId: string; title: string; files: WorkspaceFile[]; subtitle?: string; tone?: 'normal' | 'warn' }
  | { type: 'approval'; id: string; turnId: string; request: ApprovalRequest }
  | { type: 'turn'; id: string; turnId: string; activities: Activity[]; collapsed: boolean; finalMessageId?: string; startedAt: number; endedAt?: number; status?: TurnBlockStatus }

export type MessageBlock = Extract<Block, { type: 'user' | 'agent' }>

export type ToastKind = 'info' | 'warn' | 'error'
export interface Toast { id: string; kind: ToastKind; text: string }

export interface ProviderForm {
  baseUrl: string
  apiKey: string
  model: string
  wireApi: 'responses' | 'chat'
}

export type Panel = null | 'search' | 'skills' | 'plugins' | 'automations' | 'history' | 'shared' | 'files'

export interface ThreadSummary {
  id: string
  preview?: string
  createdAt?: number
  updatedAt?: number
  name?: string | null
}

export interface SharedSession {
  id: string
  owner?: string
  title?: string | null
  local_thread_id?: string | null
  created_at?: string
  updated_at?: string
}

export interface SharedSessionSnapshot {
  version?: number
  title?: string
  localThreadId?: string | null
  blocks?: Block[]
  artifacts?: SharedArtifact[]
  updatedAt?: number
  revision?: number | null
}

export interface SharedSessionMutation {
  title?: string
  localThreadId?: string | null
  snapshot?: SharedSessionSnapshot
  baseRevision?: number | null
}

export interface SharedArtifact {
  id: string
  workspace_id?: string
  session_id?: string
  name: string
  mime_type?: string | null
  size_bytes?: number
  sha256?: string
  local_path?: string | null
  turn_id?: string | null
  created_at?: string
}

export interface SkillMeta {
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

export type LocalSkillSource = 'workspace' | 'user' | 'system' | 'pluginCache'
export interface LocalSkillMeta {
  name: string
  description?: string
  shortDescription?: string
  displayName?: string
  path: string
  source: LocalSkillSource
}

export interface DiscoverLocalSkillsResult {
  skills: LocalSkillMeta[]
  errors: string[]
}

export interface AttachmentMeta {
  id: string
  name: string
  path: string
  mime: string
  kind: 'image' | 'file'
  size: number
}

export interface PickAttachmentsResult {
  attachments: Omit<AttachmentMeta, 'id'>[]
  errors: string[]
}

export interface PathStatResult {
  exists: boolean
  isFile?: boolean
  isDirectory?: boolean
  size?: number
  mtimeMs?: number
  error?: string
}

export interface ArtifactScanResult {
  root: string
  artifacts: Array<{
    name: string
    path: string
    size: number
    mtimeMs: number
  }>
}

export interface EnterpriseConfig {
  serverUrl: string
  tenantId: string
  clientId: string
  apiScope: string
  authority: string
}

export type EnterpriseForm = EnterpriseConfig

export interface EnterpriseStatus {
  configured: boolean
  signedIn: boolean
  account: {
    username?: string
    name?: string
    homeAccountId?: string
    expiresAt?: number
  } | null
  config: EnterpriseConfig
}

export interface EnterpriseDeviceCode {
  userCode?: string
  verificationUri?: string
  message?: string
  expiresOn?: number | null
}

export interface SharedWorkspace {
  id: string
  name: string
  owner_key?: string
  created_at?: string
  updated_at?: string
}

export interface McpServerView {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

export type McpServerStartupStatus = 'starting' | 'ready' | 'failed' | 'cancelled'

export interface McpServerStartupView {
  status: McpServerStartupStatus
  error?: string | null
}

export interface AppSettingsView {
  provider?: { baseUrl: string; apiKey: string; model: string; wireApi: 'responses' | 'chat' }
  enterprise?: EnterpriseConfig
  mcpServers?: McpServerView[]
  warnings?: string[]
}

export interface WorkspaceRuntimeInfo {
  nodePath: string
  nodeModulesPath: string
  pythonPath: string
  available: boolean
  nodeAvailable: boolean
  pythonAvailable: boolean
}

export interface RuntimeHostInfo {
  workspaceRoot: string
  attachmentDir: string
  codexRunning: boolean
  bridgePort: number | null
  provider?: { baseUrl: string; model: string; wireApi: 'responses' | 'chat' }
  workspaceRuntime?: WorkspaceRuntimeInfo
}

export interface RuntimeInfo extends Partial<RuntimeHostInfo> {
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
