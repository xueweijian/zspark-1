import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'

export type AttachmentKind = 'image' | 'file'

export interface ImportedAttachment {
  name: string
  path: string
  mime: string
  kind: AttachmentKind
  size: number
}

export interface ImportAttachmentsResult {
  attachments: ImportedAttachment[]
  errors: string[]
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

export function guessMimeType(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function attachmentKindForMime(mime: string): AttachmentKind {
  return mime.startsWith('image/') ? 'image' : 'file'
}

export function sanitizeAttachmentName(name: string): string {
  const safe = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return safe.slice(0, 140) || 'attachment'
}

export function importAttachmentFiles(filePaths: string[], workspaceRoot: string): ImportAttachmentsResult {
  const attachmentsDir = join(workspaceRoot, '.zspark-attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  writeFileSync(join(attachmentsDir, '.gitignore'), '*\n!.gitignore\n')

  const attachments: ImportedAttachment[] = []
  const errors: string[] = []

  for (const sourcePath of filePaths) {
    try {
      if (!existsSync(sourcePath)) throw new Error('file does not exist')
      const name = sanitizeAttachmentName(basename(sourcePath))
      const targetPath = join(attachmentsDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`)
      copyFileSync(sourcePath, targetPath)
      const mime = guessMimeType(sourcePath)
      attachments.push({
        name,
        path: targetPath,
        mime,
        kind: attachmentKindForMime(mime),
        size: statSync(targetPath).size
      })
    } catch (err: any) {
      errors.push(`${basename(sourcePath)}: ${err?.message ?? String(err)}`)
    }
  }

  return { attachments, errors }
}
