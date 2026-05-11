export function normalizeMarkdownForDisplay(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceMarker: string | null = null
  let blankCount = 0

  for (const line of lines) {
    const fence = line.match(/^ {0,3}(```+|~~~+)/)
    if (fence) {
      const marker = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      out.push(line)
      blankCount = 0
      continue
    }

    if (inFence) {
      out.push(line)
      continue
    }

    const trimmedRight = line.replace(/[ \t]+$/g, '')
    if (trimmedRight.trim() === '') {
      blankCount += 1
      if (blankCount <= 1) out.push('')
      continue
    }

    blankCount = 0
    out.push(trimmedRight)
  }

  return out.join('\n').trim()
}
