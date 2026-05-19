import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'

const ARTIFACT_EXTENSIONS = new Set([
  '.pptx',
  '.ppt',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.csv',
  '.pdf',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
])

const SCRATCH_SEGMENTS = new Set(['assets', 'layout', 'preview', 'qa', 'slides'])

export interface RecentArtifact {
  name: string
  path: string
  size: number
  mtimeMs: number
}

interface ScanOptions {
  sinceMs?: number
  limit?: number
  maxDepth?: number
}

function isArtifactFile(path: string) {
  return ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase())
}

function isScratchArtifact(workspaceRoot: string, path: string) {
  if (basename(path).toLowerCase() === 'contact-sheet.png') return true
  const segments = relative(join(workspaceRoot, 'outputs'), path).split(sep)
  return segments.some((segment) => SCRATCH_SEGMENTS.has(segment))
}

export function scanRecentArtifacts(workspaceRoot: string, options: ScanOptions = {}): RecentArtifact[] {
  const outputsRoot = join(workspaceRoot, 'outputs')
  const sinceMs = options.sinceMs ?? 0
  const limit = options.limit ?? 24
  const maxDepth = options.maxDepth ?? 10
  const found: RecentArtifact[] = []

  function visit(dir: string, depth: number) {
    if (depth > maxDepth || !existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      let lstat
      try {
        lstat = lstatSync(path)
      } catch {
        continue
      }

      if (lstat.isSymbolicLink()) continue
      if (lstat.isDirectory()) {
        visit(path, depth + 1)
        continue
      }
      if (!lstat.isFile() || !isArtifactFile(path) || isScratchArtifact(workspaceRoot, path)) continue

      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.mtimeMs < sinceMs) continue

      found.push({
        name: basename(path),
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      })
    }
  }

  visit(outputsRoot, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}
