const ARTIFACT_EXTENSION_RE = /\.(pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip)\b/i
const PATH_TOKEN_RE = /`([^`\n\r]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))`|["']([^"'\n\r]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))["']|([^\s`"'<>()[\]{}，。；：、]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))/gi
const SCRATCH_ARTIFACT_SEGMENTS = new Set(['assets', 'layout', 'preview', 'qa', 'slides'])

export interface RecentArtifactLike {
  name: string
  path: string
  size: number
  mtimeMs: number
}

function stripTrailingPunctuation(path: string) {
  return path.replace(/[),.;:，。；：、]+$/g, '')
}

function looksLikeWorkspaceArtifact(path: string, allowBareName = false) {
  if (/^https?:\/\//i.test(path)) return false
  if (!ARTIFACT_EXTENSION_RE.test(path)) return false
  if (allowBareName) return true
  return path.startsWith('/') || path.startsWith('.') || path.includes('/') || path.includes('\\')
}

export function extractArtifactPathCandidates(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const candidate = stripTrailingPunctuation(String(match[1] ?? match[2] ?? match[3] ?? '').trim())
    const quoted = match[1] != null || match[2] != null
    if (!candidate || !looksLikeWorkspaceArtifact(candidate, quoted) || seen.has(candidate)) continue
    seen.add(candidate)
    result.push(candidate)
  }
  return result
}

export function isAbsolutePath(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

export function resolveWorkspacePath(path: string, base?: string) {
  if (!path || isAbsolutePath(path) || !base) return path
  return `${base.replace(/[\\/]+$/, '')}/${path}`
}

function normalizeArtifactPath(path: string) {
  return stripTrailingPunctuation(path.trim()).replace(/\\/g, '/').replace(/\/+/g, '/')
}

export function isDisplayableArtifactPath(path: string) {
  const trimmed = stripTrailingPunctuation(path.trim())
  if (/^https?:\/\//i.test(trimmed)) return false
  const normalized = normalizeArtifactPath(trimmed)
  if (!looksLikeWorkspaceArtifact(normalized)) return false
  const segments = normalized.split('/').filter(Boolean)
  return !segments.some((segment) => SCRATCH_ARTIFACT_SEGMENTS.has(segment))
}

function pathBasename(path: string) {
  const normalized = normalizeArtifactPath(path)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

export function findRecentArtifactForCandidate(
  candidate: string,
  artifacts: RecentArtifactLike[]
): RecentArtifactLike | null {
  const normalizedCandidate = normalizeArtifactPath(candidate).toLowerCase()
  if (!normalizedCandidate) return null

  const suffixMatch = artifacts.find((artifact) => {
    const normalizedArtifactPath = normalizeArtifactPath(artifact.path).toLowerCase()
    return normalizedArtifactPath === normalizedCandidate || normalizedArtifactPath.endsWith(`/${normalizedCandidate}`)
  })
  if (suffixMatch) return suffixMatch

  const candidateName = pathBasename(normalizedCandidate)
  if (!candidateName) return null
  return artifacts.find((artifact) => (
    pathBasename(artifact.path).toLowerCase() === candidateName ||
    artifact.name.trim().toLowerCase() === candidateName
  )) ?? null
}

export function dirname(path?: string) {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : undefined
}
