const ARTIFACT_EXTENSION_RE = /\.(pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip)\b/i
const PATH_TOKEN_RE = /`([^`\n\r]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))`|["']([^"'\n\r]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))["']|([^\s`"'<>()[\]{}，。；：、]+\.(?:pptx|ppt|docx|doc|xlsx|xls|csv|pdf|png|jpe?g|webp|zip))/gi

function stripTrailingPunctuation(path: string) {
  return path.replace(/[),.;:，。；：、]+$/g, '')
}

function looksLikeWorkspaceArtifact(path: string) {
  if (/^https?:\/\//i.test(path)) return false
  if (!ARTIFACT_EXTENSION_RE.test(path)) return false
  return path.startsWith('/') || path.startsWith('.') || path.includes('/') || path.includes('\\')
}

export function extractArtifactPathCandidates(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const candidate = stripTrailingPunctuation(String(match[1] ?? match[2] ?? match[3] ?? '').trim())
    if (!candidate || !looksLikeWorkspaceArtifact(candidate) || seen.has(candidate)) continue
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

export function dirname(path?: string) {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : undefined
}
