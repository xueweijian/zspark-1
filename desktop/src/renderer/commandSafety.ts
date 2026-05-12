export interface CommandFailureSignal {
  title: string
  detail: string
}

const STRONG_DENIAL_KEYWORDS = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'failed to write file'
]

const FILE_OPERATION_MARKERS = [
  'cp:',
  'ln:',
  'mkdir:',
  'mv:',
  'osascript',
  'rm:',
  'rmdir:',
  'touch:',
  'trash:'
]

export function detectMaskedCommandFailure(output: string): CommandFailureSignal | null {
  const text = String(output ?? '').trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const hasDeniedKeyword = STRONG_DENIAL_KEYWORDS.some((keyword) => lower.includes(keyword))
  const hasFileOperationMarker = FILE_OPERATION_MARKERS.some((marker) => lower.includes(marker))
  if (!hasDeniedKeyword || !hasFileOperationMarker) return null

  const deniedLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const lineLower = line.toLowerCase()
      return STRONG_DENIAL_KEYWORDS.some((keyword) => lineLower.includes(keyword))
    })
    .slice(0, 4)

  return {
    title: 'Permission blocked',
    detail: deniedLines.length
      ? deniedLines.join('\n')
      : 'The command output contains a filesystem permission denial.'
  }
}

export function commandFailureNotice(signal: CommandFailureSignal) {
  return `${signal.title}.\n\nThe requested action did not complete. The command output shows a filesystem permission block, so success was not confirmed.`
}
