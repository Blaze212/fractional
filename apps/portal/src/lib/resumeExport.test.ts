import { describe, it, expect } from 'vitest'
import { mapParsedProfileToRenderData } from './resumeExport'
import type { ParsedProfile } from './resumeTypes'

const baseProfile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: 'https://linkedin.com/in/janesmith',
  current_title: 'CFO',
  work_authorization: 'U.S. Citizen',
  total_experience: '15 years',
  summary: 'Paragraph one.\n\nParagraph two.',
  career_highlights: ['Led $50M raise', 'Cut burn by 30%'],
  selected_experience: [
    {
      company: 'Acme Corp',
      title: 'CFO',
      start_date: '2020-01',
      end_date: 'Present',
      responsibilities: ['Oversaw finance'],
      achievements: ['Raised Series C'],
    },
  ],
  other_experience: [
    {
      company: 'OldCo',
      title: 'VP Finance',
      start_date: '2016-06',
      end_date: '2019-12',
    },
  ],
  education: [{ institution: 'Harvard', degree: 'MBA' }],
  certifications: [{ provider: 'AICPA', certification: 'CPA' }],
  skills: ['Financial planning', 'M&A'],
  tools: ['NetSuite', 'Excel'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance'],
  industries: ['SaaS'],
}

const STUB_LOGO = new Uint8Array([1, 2, 3])

describe('mapParsedProfileToRenderData', () => {
  it('maps name correctly', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.name).toBe('Jane Smith')
  })

  it('builds headerLine from phone | email | location | linkedin', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.headerLine).toContain('+1 555 0100')
    expect(rd.headerLine).toContain('jane@example.com')
    expect(rd.headerLine).toContain('New York, NY')
    expect(rd.headerLine).toContain('https://linkedin.com/in/janesmith')
  })

  it('splits summary at \\n\\n into summaryParagraph1 and summaryParagraph2', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.summaryParagraph1).toBe('Paragraph one.')
    expect(rd.summaryParagraph2).toBe('Paragraph two.')
  })

  it('maps careerHighlights to text objects', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.careerHighlights).toHaveLength(2)
    expect(rd.careerHighlights[0]).toEqual({ text: 'Led $50M raise' })
  })

  it('formats YYYY-MM dates to "Mon YYYY"', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    const exp = rd.selectedExperience[0]
    expect(exp.dates).toBe('Jan 2020 – Present')
  })

  it('formats other_experience as combined text with date range', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    const other = rd.otherExperience[0]
    expect(other.text).toContain('OldCo')
    expect(other.text).toContain('VP Finance')
    expect(other.text).toContain('Jun 2016')
    expect(other.text).toContain('Dec 2019')
  })

  it('maps selectedExperience responsibilities and achievements to text objects', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.selectedExperience[0].responsibilities).toEqual([{ text: 'Oversaw finance' }])
    expect(rd.selectedExperience[0].achievements).toEqual([{ text: 'Raised Series C' }])
  })

  it('sets show flags based on content presence', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.showSummary).toBe(true)
    expect(rd.showCareerHighlights).toBe(true)
    expect(rd.showOtherExperience).toBe(true)
    expect(rd.showEducationCertifications).toBe(true)
    expect(rd.showSkillsTools).toBe(true)
    expect(rd.selectedExperience[0].showResponsibilities).toBe(true)
    expect(rd.selectedExperience[0].showAchievements).toBe(true)
  })

  it('joins skills and tools with comma', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.skillsLine).toBe('Financial planning, M&A')
    expect(rd.toolsLine).toBe('NetSuite, Excel')
  })

  it('adds sponsorship constant', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, STUB_LOGO)
    expect(rd.sponsorship).toContain('Authorized to work in the US')
  })

  it('handles null summary gracefully (empty strings)', () => {
    const profile = { ...baseProfile, summary: null }
    const rd = mapParsedProfileToRenderData(profile, STUB_LOGO)
    expect(rd.summaryParagraph1).toBe('')
    expect(rd.summaryParagraph2).toBe('')
    expect(rd.showSummary).toBe(false)
  })

  it('handles missing linkedin_url in headerLine', () => {
    const profile = { ...baseProfile, linkedin_url: null }
    const rd = mapParsedProfileToRenderData(profile, STUB_LOGO)
    expect(rd.headerLine).not.toContain('null')
    expect(rd.headerLine).toContain('jane@example.com')
  })
})
