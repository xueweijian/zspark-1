export type SkillCategory = 'work' | 'office' | 'research' | 'creative' | 'automation' | 'utility' | 'developer' | 'all'

export interface SkillCatalogEntry {
  name: string
  displayName?: string
  description?: string
  shortDescription?: string
  path?: string
  scope?: string
  source?: string
  enabled?: boolean
  availability?: 'usable' | 'localOnly'
}

export interface AttachmentLike {
  name: string
  mime: string
  kind: 'image' | 'file'
}

export const skillCategoryOptions: Array<{ id: SkillCategory; label: string }> = [
  { id: 'work', label: 'Work' },
  { id: 'office', label: 'Office' },
  { id: 'research', label: 'Research' },
  { id: 'creative', label: 'Creative' },
  { id: 'automation', label: 'Automation' },
  { id: 'developer', label: 'Developer' },
  { id: 'all', label: 'All' }
]

const OFFICE_RE = /\b(document|documents|docx|word|presentation|presentations|slides?|pptx?|powerpoint|spreadsheet|spreadsheets|xlsx?|excel|csv|tsv|pdf|office|deck)\b/i
const RESEARCH_RE = /\b(browser|browse|web|search|research|docs?|openai-docs|computer-use|computer use)\b/i
const CREATIVE_RE = /\b(image|imagegen|visual|bitmap|illustration|mockup)\b/i
const AUTOMATION_RE = /\b(automation|automations|schedule|recurring|cron|workflow|monitor|babysit)\b/i
const DEVELOPER_RE = /\b(code|coding|developer|programming|frontend|backend|react|next\.?js|typescript|javascript|node|express|rust|tui|git|pull request|pr\b|ci\b|test|testing|bug|issue|review|security|stripe|supabase|shadcn|api route|database|postgres|bazel)\b/i

function catalogText(skill: SkillCatalogEntry): string {
  return [
    skill.name,
    skill.displayName,
    skill.shortDescription,
    skill.description,
    skill.scope,
    skill.source,
    skill.path
  ].filter(Boolean).join(' ')
}

export function inferSkillCategory(skill: SkillCatalogEntry): Exclude<SkillCategory, 'work' | 'all'> {
  const text = catalogText(skill)
  if (OFFICE_RE.test(text)) return 'office'
  if (CREATIVE_RE.test(text)) return 'creative'
  if (RESEARCH_RE.test(text)) return 'research'
  if (AUTOMATION_RE.test(text)) return 'automation'
  if (DEVELOPER_RE.test(text)) return 'developer'
  return 'utility'
}

export function isDeveloperSkill(skill: SkillCatalogEntry): boolean {
  return inferSkillCategory(skill) === 'developer'
}

export function matchesSkillQuery(skill: SkillCatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return catalogText(skill).toLowerCase().includes(q)
}

export function skillCategoryMatches(skill: SkillCatalogEntry, category: SkillCategory): boolean {
  if (category === 'all') return true
  const inferred = inferSkillCategory(skill)
  if (category === 'work') return inferred !== 'developer'
  return inferred === category
}

export function filterSkillCatalog(
  skills: SkillCatalogEntry[],
  category: SkillCategory,
  query: string
): SkillCatalogEntry[] {
  return skills
    .filter((skill) => skillCategoryMatches(skill, category))
    .filter((skill) => matchesSkillQuery(skill, query))
    .sort((a, b) => {
      const availability = availabilityRank(a) - availabilityRank(b)
      if (availability !== 0) return availability
      const categoryRank = categoryOrder(inferSkillCategory(a)) - categoryOrder(inferSkillCategory(b))
      if (categoryRank !== 0) return categoryRank
      return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)
    })
}

function availabilityRank(skill: SkillCatalogEntry): number {
  if (skill.availability === 'localOnly') return 2
  if (skill.enabled === false) return 1
  return 0
}

function categoryOrder(category: Exclude<SkillCategory, 'work' | 'all'>): number {
  switch (category) {
    case 'office': return 0
    case 'research': return 1
    case 'creative': return 2
    case 'automation': return 3
    case 'utility': return 4
    case 'developer': return 5
  }
}

export function recommendedSkillNamesForAttachment(attachment: AttachmentLike): string[] {
  const haystack = `${attachment.name} ${attachment.mime}`.toLowerCase()
  if (attachment.kind === 'image') return ['imagegen']
  if (/\b(docx?|word|pdf)\b/.test(haystack)) return ['documents']
  if (/\b(pptx?|powerpoint|presentation|slides?)\b/.test(haystack)) return ['Presentations', 'presentations']
  if (/\b(xlsx?|xls|csv|tsv|spreadsheet|excel)\b/.test(haystack)) return ['Spreadsheets', 'spreadsheets']
  return []
}

export function suggestedPromptForAttachments(attachments: AttachmentLike[]): string {
  if (attachments.length === 0) return ''
  const hasImage = attachments.some((a) => a.kind === 'image')
  const hasDoc = attachments.some((a) => /\b(docx?|word|pdf)\b/i.test(`${a.name} ${a.mime}`))
  const hasDeck = attachments.some((a) => /\b(pptx?|powerpoint|presentation|slides?)\b/i.test(`${a.name} ${a.mime}`))
  const hasSheet = attachments.some((a) => /\b(xlsx?|xls|csv|tsv|spreadsheet|excel)\b/i.test(`${a.name} ${a.mime}`))

  if (attachments.length === 1 && hasImage) return '请识别这张图片，提取关键信息，并说明下一步可以怎么处理。'
  if (hasDeck) return '请分析这份演示文稿，给出结构、叙事和视觉上的改进建议；如果需要修改，请直接在工作区产出可编辑版本。'
  if (hasSheet) return '请分析这份表格文件，说明关键发现、数据质量问题和可以改进的地方；如果需要修改，请直接在工作区产出可编辑版本。'
  if (hasDoc) return '请审阅这份文档，提取重点、风险和修改建议；如果需要改写，请直接在工作区产出可编辑版本。'
  return '请读取这些附件，先总结内容，再根据文件类型给出可执行的处理建议。'
}
