import type { WorkspaceFile } from './appTypes'

export interface ScannedArtifactRevision {
  path: string
  mtimeMs: number
}

export function rememberDisplayedArtifactRevisions(files: WorkspaceFile[], shown: Map<string, number>) {
  for (const file of files) {
    if (file.status === 'missing') continue
    const previous = shown.get(file.path) ?? 0
    shown.set(file.path, Math.max(previous, file.updatedAt))
  }
}

export function shouldDisplayScannedArtifact(
  artifact: ScannedArtifactRevision,
  shown: ReadonlyMap<string, number>
): boolean {
  const displayedAt = shown.get(artifact.path)
  return displayedAt === undefined || artifact.mtimeMs > displayedAt
}

export function clearDisplayedArtifactRevisions(shown: Map<string, number>) {
  shown.clear()
}
