import { app, shell } from 'electron'
import { realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Path-safety helpers for IPC handlers in the Electron main process.
 *
 * The renderer is contextIsolated and validated, but a compromised renderer
 * (XSS via markdown / chat content / supply chain) would still talk to us
 * through these channels. Each helper restricts what the OS can ultimately
 * see — workspace + Downloads only, with an extension allowlist for shell
 * launches and a scheme allowlist for external URL handoff.
 */

export function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export function allowedLocalPathRoots(workspaceRoot: string): string[] {
  return [workspaceRoot, app.getPath('downloads')]
}

function realpathIfAvailable(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Resolve `realpathSync` for the deepest existing ancestor of `path` and
 * re-attach the missing tail. Lets us validate paths to files that haven't
 * been written yet (codex artifact streaming, fresh download targets) while
 * still defeating symlink-escape attacks on every existing segment.
 */
function realpathOfDeepestExistingAncestor(path: string): string {
  let dir = path
  const tail: string[] = []
  while (true) {
    try {
      const real = realpathSync(dir)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(dir)
      if (parent === dir) {
        // Reached filesystem root with no realpath success — fall back to
        // a syntactic resolve so callers still get a sane absolute path.
        return resolve(path)
      }
      const segment = dir.slice(parent.length)
      tail.push(segment.startsWith(sep) ? segment.slice(sep.length) : segment)
      dir = parent
    }
  }
}

export function resolveAllowedLocalPath(workspaceRoot: string, filePath: string): string {
  const normalized = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath)
  const roots = allowedLocalPathRoots(workspaceRoot).map(realpathIfAvailable)
  const realPath = realpathOfDeepestExistingAncestor(normalized)
  if (!roots.some((root) => isInsidePath(root, realPath))) {
    throw new Error('Path resolves outside the allowed zspark workspace/download directories')
  }
  return realPath
}

export async function openExternalUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl)
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
    throw new Error('Unsupported link protocol')
  }
  await shell.openExternal(url.toString())
}

// Files explicitly allowed to be opened with the OS default handler from a
// path:open IPC. Anything else (executables, scripts, .app bundles, …) is
// blocked so a compromised renderer can't launch arbitrary binaries.
const SHELL_OPEN_ALLOWED_EXTENSIONS = new Set<string>([
  '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.html', '.htm', '.xml',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.mp3', '.wav', '.flac', '.mp4', '.mov', '.webm',
  '.zip'
])

export function ensureShellOpenAllowed(filePath: string): void {
  const ext = extname(filePath).toLowerCase()
  if (!ext) {
    throw new Error('Files without an extension cannot be opened from zspark')
  }
  if (!SHELL_OPEN_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Opening ${ext} files from zspark is not allowed`)
  }
}
