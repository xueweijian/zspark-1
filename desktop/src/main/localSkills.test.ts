import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { discoverLocalSkills, parseSkillMarkdown } from './localSkills'

const tempDirs: string[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'zspark-local-skills-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('local skill discovery', () => {
  test('parses quoted SKILL.md frontmatter', () => {
    const skill = parseSkillMarkdown(
      '---\nname: "Spreadsheets"\ndescription: "Work with xlsx files"\n---\n# Body',
      '/tmp/skills/spreadsheets/SKILL.md',
      'pluginCache'
    )

    expect(skill).toEqual({
      name: 'Spreadsheets',
      description: 'Work with xlsx files',
      shortDescription: 'Work with xlsx files',
      displayName: undefined,
      path: '/tmp/skills/spreadsheets/SKILL.md',
      source: 'pluginCache'
    })
  })

  test('discovers workspace, system, user, and plugin-cache skills', () => {
    const workspace = tempDir()
    const home = tempDir()
    const paths = [
      join(workspace, '.codex', 'skills', 'office', 'SKILL.md'),
      join(home, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
      join(home, '.codex', 'skills', 'personal', 'SKILL.md'),
      join(home, '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'documents', '1', 'skills', 'documents', 'SKILL.md')
    ]

    for (const path of paths) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, `---\nname: ${path.includes('documents') ? 'documents' : 'demo'}\ndescription: Demo skill\n---\n`)
    }

    const result = discoverLocalSkills(workspace, home)

    expect(result.errors).toEqual([])
    expect(result.skills.map((s) => s.source).sort()).toEqual(['pluginCache', 'system', 'user', 'workspace'])
    expect(result.skills.some((s) => s.name === 'documents' && s.source === 'pluginCache')).toBe(true)
  })
})
