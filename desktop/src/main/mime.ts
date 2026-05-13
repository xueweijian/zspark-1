import { extname } from 'node:path'

/**
 * MIME-type lookup for office artifacts. Kept as a tiny switch instead of a
 * dependency because zspark only cares about the handful of types our
 * skills/agents produce.
 */
export function artifactMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.ppt':  return 'application/vnd.ms-powerpoint'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.doc':  return 'application/msword'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xls':  return 'application/vnd.ms-excel'
    case '.csv':  return 'text/csv'
    case '.pdf':  return 'application/pdf'
    case '.png':  return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.zip':  return 'application/zip'
    default:      return 'application/octet-stream'
  }
}

/**
 * Pull the filename out of a `Content-Disposition` header. Honors the
 * RFC 5987 `filename*=UTF-8''…` form used by our server when the artifact
 * name contains non-ASCII characters.
 */
export function contentDispositionFileName(header: string | null): string | null {
  if (!header) return null
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1]) } catch {}
  }
  return /filename="([^"]+)"/i.exec(header)?.[1]
    ?? /filename=([^;]+)/i.exec(header)?.[1]?.trim()
    ?? null
}
