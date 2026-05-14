import { describe, expect, test } from 'vitest'
import {
  filterSkillCatalog,
  inferSkillCategory,
  isOfficeArtifactGenerationRequest,
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

  test('detects office artifact generation requests without treating analysis as generation', () => {
    expect(isOfficeArtifactGenerationRequest('给我生成一页年终总结ppt')).toBe(true)
    expect(isOfficeArtifactGenerationRequest('export the results as a Word docx')).toBe(true)
    expect(isOfficeArtifactGenerationRequest('请分析这份演示文稿')).toBe(false)
    expect(isOfficeArtifactGenerationRequest('请读取这个 PDF 总结要点')).toBe(false)
    expect(isOfficeArtifactGenerationRequest('请做成一页总结', [{ name: 'presentations' }])).toBe(false)
    expect(isOfficeArtifactGenerationRequest('请做成一页 PPT', [{ name: 'presentations' }])).toBe(true)
  })
})
