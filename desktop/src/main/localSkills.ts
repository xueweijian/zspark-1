import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type LocalSkillSource = 'workspace' | 'user' | 'system' | 'pluginCache'

export interface LocalSkillMetadata {
  name: string
  description?: string
  shortDescription?: string
  displayName?: string
  path: string
  source: LocalSkillSource
}

export interface DiscoverLocalSkillsResult {
  skills: LocalSkillMetadata[]
  errors: string[]
}

const SKILL_FILE = 'SKILL.md'
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'out',
  'dist',
  'build',
  '.next',
  '.vite'
])

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const entries: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!parsed) continue
    entries[parsed[1]] = unquote(parsed[2])
  }
  return entries
}

function fallbackSkillName(path: string): string {
  return basename(dirname(path)) || basename(path)
}

export function parseSkillMarkdown(raw: string, path: string, source: LocalSkillSource): LocalSkillMetadata {
  const frontmatter = parseFrontmatter(raw)
  const name = frontmatter.name?.trim() || fallbackSkillName(path)
  const description = frontmatter.description?.trim() || undefined
  return {
    name,
    displayName: frontmatter.display_name?.trim() || frontmatter.displayName?.trim() || undefined,
    shortDescription: frontmatter.short_description?.trim() || frontmatter.shortDescription?.trim() || description,
    description,
    path,
    source
  }
}

function findSkillFiles(root: string, errors: string[], maxDepth = 12): string[] {
  if (!existsSync(root)) return []

  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err: unknown) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && entry.name === SKILL_FILE) {
        found.push(path)
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        visit(path, depth + 1)
      }
    }
  }

  visit(root, 0)
  return found
}

function readSkill(path: string, source: LocalSkillSource, errors: string[]): LocalSkillMetadata | null {
  try {
    return parseSkillMarkdown(readFileSync(path, 'utf8'), path, source)
  } catch (err: unknown) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function discoverLocalSkills(workspaceRoot: string, homeDir = homedir()): DiscoverLocalSkillsResult {
  const errors: string[] = []
  const byPath = new Map<string, LocalSkillMetadata>()
  const addRoot = (root: string, source: LocalSkillSource) => {
    for (const path of findSkillFiles(root, errors)) {
      if (byPath.has(path)) continue
      const skill = readSkill(path, source, errors)
      if (skill) byPath.set(path, skill)
    }
  }

  const codexSkillsRoot = join(homeDir, '.codex', 'skills')
  addRoot(join(workspaceRoot, '.codex', 'skills'), 'workspace')
  addRoot(join(workspaceRoot, '.agents', 'skills'), 'workspace')
  addRoot(join(codexSkillsRoot, '.system'), 'system')
  addRoot(codexSkillsRoot, 'user')
  addRoot(join(homeDir, '.codex', 'plugins', 'cache'), 'pluginCache')

  return {
    skills: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errors
  }
}
