import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import PizZip from 'pizzip'
import { mapToSubmittalRenderData, exportSubmittal, renderSubmittalDocx } from './submittalExport'
import type { SubmittalFields } from './submittalExport'
import type { ParsedProfile } from './resumeTypes'

const TEMPLATE_PATH = resolve(__dirname, '../../public/submittal-template.docx')

function loadTemplate(): ArrayBuffer {
  const buf = readFileSync(TEMPLATE_PATH)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const profile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: 'https://linkedin.com/in/janesmith',
  summary: 'Experienced CFO.',
  career_highlights: ['Led $50M Series C', 'Reduced burn by 30%'],
  selected_experience: [
    {
      company: 'Acme Corp',
      title: 'CFO',
      start_date: '2019-01',
      end_date: 'Present',
      responsibilities: ['Oversaw finance'],
      achievements: ['Raised $50M Series C'],
    },
  ],
  other_experience: [],
  education: [],
  certifications: [],
  skills: ['Financial planning', 'M&A'],
  tools: ['NetSuite'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance'],
  industries: ['SaaS'],
}

const fields: SubmittalFields = {
  clientName: 'Globex',
  roleTitle: 'Chief Financial Officer',
  reqId: 'REQ-123',
  location: 'Remote',
  hiringManager: 'Sam Carter',
  fitSummary: 'A C-Level finance leader ready to scale Globex.',
  fitBullets: [
    { text: 'Raised a $50M Series C.', source_ref: 'selected_experience[0]' },
    { text: 'Reduced burn by 30%.', source_ref: 'career_highlights[1]' },
    { text: 'Deep SaaS finance expertise.', source_ref: 'industries' },
  ],
  compLogistics: 'Target $300k base + equity.',
  recruiterNotes: 'Available to start in 4 weeks.',
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

function renderedText(blob: ArrayBuffer): string {
  const zip = new PizZip(blob)
  return zip.files['word/document.xml'].asText()
}

describe('mapToSubmittalRenderData', () => {
  it('maps client/role and candidate snapshot fields', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    expect(rd.client_name).toBe('Globex')
    expect(rd.role_title).toBe('Chief Financial Officer')
    expect(rd.candidate_name).toBe('Jane Smith')
    expect(rd.candidate_seniority).toBe('C-Level')
    expect(rd.candidate_titles).toContain('CFO at Acme Corp')
  })

  it('sets show flags from optional field presence', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    expect(rd.show_req_id).toBe(true)
    expect(rd.show_comp_logistics).toBe(true)
    const rdEmpty = mapToSubmittalRenderData(profile, {
      ...fields,
      reqId: '   ',
      compLogistics: '',
    })
    expect(rdEmpty.show_req_id).toBe(false)
    expect(rdEmpty.show_comp_logistics).toBe(false)
  })

  it('carries the 3 fit bullets and recent experience', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    expect(rd.fit_bullets).toHaveLength(3)
    expect(rd.recent_experience[0].company).toBe('Acme Corp')
  })
})

describe('exportSubmittal', () => {
  it('renders all merge fields and the fit_bullets loop with a logo', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    const buf = renderSubmittalDocx(loadTemplate(), rd, {
      bytes: PNG_BYTES,
      dims: { widthPx: 200, heightPx: 100 },
    })
    const xml = renderedText(buf)

    expect(xml).toContain('Globex')
    expect(xml).toContain('Chief Financial Officer')
    expect(xml).toContain('REQ-123')
    expect(xml).toContain('Jane Smith')
    expect(xml).toContain('Raised a $50M Series C.')
    expect(xml).toContain('Reduced burn by 30%.')
    expect(xml).toContain('Target $300k base')
    // section + loop tags must be consumed by the renderer
    expect(xml).not.toContain('{{')
    expect(xml).not.toContain('fit_bullets')
  })

  it('omits hidden optional sections', () => {
    const rd = mapToSubmittalRenderData(profile, {
      ...fields,
      reqId: '',
      compLogistics: '',
      recruiterNotes: '',
    })
    const buf = renderSubmittalDocx(loadTemplate(), rd, {
      bytes: PNG_BYTES,
      dims: { widthPx: 200, heightPx: 100 },
    })
    const xml = renderedText(buf)
    expect(xml).not.toContain('REQ-123')
    expect(xml).not.toContain('Compensation')
    expect(xml).not.toContain('Recruiter Notes')
  })

  it('succeeds with no logo (transparent placeholder retained)', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    const buf = renderSubmittalDocx(loadTemplate(), rd, null)
    expect(buf.byteLength).toBeGreaterThan(0)
    const xml = renderedText(buf)
    expect(xml).toContain('Globex')
  })

  it('exportSubmittal returns a docx Blob', () => {
    const rd = mapToSubmittalRenderData(profile, fields)
    const blob = exportSubmittal(loadTemplate(), rd, null)
    expect(blob.type).toContain('wordprocessingml')
  })
})
