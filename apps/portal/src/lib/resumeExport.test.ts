import { describe, it, expect } from 'vitest'
import { mapParsedProfileToRenderData } from './resumeExport'
import type { ParsedProfile } from './resumeTypes'

const baseProfile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: 'https://linkedin.com/in/janesmith',
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

describe('mapParsedProfileToRenderData', () => {
  it('maps name correctly', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.name).toBe('Jane Smith')
  })

  it('builds headerLine from phone | email | location | linkedin', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.headerLine).toContain('+1 555 0100')
    expect(rd.headerLine).toContain('jane@example.com')
    expect(rd.headerLine).toContain('New York, NY')
    expect(rd.headerLine).toContain('https://linkedin.com/in/janesmith')
  })

  it('splits summary at \\n\\n into summary1 and summary2', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.summary1).toBe('Paragraph one.')
    expect(rd.summary2).toBe('Paragraph two.')
  })

  it('maps careerHighlights to bullet objects', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.careerHighlights).toHaveLength(2)
    expect(rd.careerHighlights[0]).toEqual({ bullet: 'Led $50M raise' })
  })

  it('formats YYYY-MM dates to "Mon YYYY"', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    const exp = rd.selectedExperience[0]
    expect(exp.dates).toBe('Jan 2020 – Present')
  })

  it('formats other_experience date range', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    const other = rd.otherExperience[0]
    expect(other.dates).toBe('Jun 2016 – Dec 2019')
  })

  it('maps selectedExperience responsibilities and achievements', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.selectedExperience[0].responsibilities).toEqual([{ bullet: 'Oversaw finance' }])
    expect(rd.selectedExperience[0].achievements).toEqual([{ bullet: 'Raised Series C' }])
  })

  it('joins skills and tools with comma', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.skillsLine).toBe('Financial planning, M&A')
    expect(rd.toolsLine).toBe('NetSuite, Excel')
  })

  it('uses 1×1 transparent PNG when no logo provided', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.company_logo).toBeInstanceOf(Uint8Array)
    expect(rd.company_logo.length).toBeGreaterThan(0)
  })

  it('uses provided logo bytes when logo is present', () => {
    const logoBytes = new Uint8Array([1, 2, 3, 4])
    const rd = mapParsedProfileToRenderData(baseProfile, logoBytes)
    expect(rd.company_logo).toBe(logoBytes)
  })

  it('adds sponsorship constant', () => {
    const rd = mapParsedProfileToRenderData(baseProfile, null)
    expect(rd.sponsorship).toContain('Authorized to work in the US')
  })

  it('handles null summary gracefully (empty strings)', () => {
    const profile = { ...baseProfile, summary: null }
    const rd = mapParsedProfileToRenderData(profile, null)
    expect(rd.summary1).toBe('')
    expect(rd.summary2).toBe('')
  })

  it('handles missing linkedin_url in headerLine', () => {
    const profile = { ...baseProfile, linkedin_url: null }
    const rd = mapParsedProfileToRenderData(profile, null)
    expect(rd.headerLine).not.toContain('null')
    expect(rd.headerLine).toContain('jane@example.com')
  })
})
