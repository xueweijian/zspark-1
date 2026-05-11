import { describe, expect, test } from 'vitest'
import {
  filterSkillCatalog,
  inferSkillCategory,
  recommendedSkillNamesForAttachment,
  suggestedPromptForAttachments
} from './skillCatalog'

describe('skill catalog helpers', () => {
  test('classifies office skills ahead of developer keywords', () => {
    expect(inferSkillCategory({
      name: 'documents',
      description: 'Create, edit, redline, and comment on `.docx` files'
    })).toBe('office')

    expect(inferSkillCategory({
      name: 'code-review',
      description: 'Run a final code review on a pull request'
    })).toBe('developer')
  })

  test('work category hides developer skills but keeps usage skills', () => {
    const skills = [
      { name: 'documents', availability: 'usable' as const },
      { name: 'code-review', availability: 'usable' as const },
      { name: 'Spreadsheets', availability: 'localOnly' as const }
    ]

    expect(filterSkillCatalog(skills, 'work', '').map((s) => s.name)).toEqual(['documents', 'Spreadsheets'])
    expect(filterSkillCatalog(skills, 'developer', '').map((s) => s.name)).toEqual(['code-review'])
  })

  test('suggests office prompts and matching skill names for attachments', () => {
    expect(recommendedSkillNamesForAttachment({
      name: 'board-readout.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      kind: 'file'
    })).toContain('Presentations')

    expect(suggestedPromptForAttachments([{
      name: 'finance.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'file'
    }])).toContain('表格')
  })
})
