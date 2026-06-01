import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import type { ParsedProfile } from './resumeTypes'
import { formatDateRange } from './resumeExport'
import { injectLogo, logoEmu } from './docxLogo'
import type { LogoDimensions } from './docxLogo'

export interface FitBullet {
  text: string
  source_ref: string
}

// Recruiter-entered + generated fields owned by the submittal page.
export interface SubmittalFields {
  clientName: string
  roleTitle: string
  reqId: string
  location: string
  hiringManager: string
  fitSummary: string
  fitBullets: FitBullet[]
  compLogistics: string
  recruiterNotes: string
}

export type SubmittalRenderData = {
  client_name: string
  role_title: string
  show_req_id: boolean
  req_id: string
  show_location: boolean
  location: string
  show_hiring_manager: boolean
  hiring_manager: string
  candidate_name: string
  candidate_seniority: string
  candidate_titles: string
  fit_summary: string
  fit_bullets: { text: string }[]
  key_qualifications: { text: string }[]
  recent_experience: { company: string; title: string; dates: string }[]
  show_comp_logistics: boolean
  comp_logistics: string
  show_recruiter_notes: boolean
  recruiter_notes: string
}

export type SubmittalLogo = { bytes: Uint8Array; dims: LogoDimensions }

function candidateTitles(profile: ParsedProfile): string {
  return profile.selected_experience
    .slice(0, 3)
    .map((e) => [e.title, e.company].filter(Boolean).join(' at '))
    .filter(Boolean)
    .join('  ·  ')
}

export function mapToSubmittalRenderData(
  profile: ParsedProfile,
  fields: SubmittalFields,
): SubmittalRenderData {
  const keyQualificationsSource =
    profile.career_highlights.length > 0 ? profile.career_highlights : profile.skills.slice(0, 6)

  return {
    client_name: fields.clientName,
    role_title: fields.roleTitle,
    show_req_id: !!fields.reqId.trim(),
    req_id: fields.reqId.trim(),
    show_location: !!fields.location.trim(),
    location: fields.location.trim(),
    show_hiring_manager: !!fields.hiringManager.trim(),
    hiring_manager: fields.hiringManager.trim(),
    candidate_name: profile.name ?? 'Candidate',
    candidate_seniority: profile.seniority_level ?? '',
    candidate_titles: candidateTitles(profile),
    fit_summary: fields.fitSummary,
    fit_bullets: fields.fitBullets.map((b) => ({ text: b.text })),
    key_qualifications: keyQualificationsSource.map((text) => ({ text })),
    recent_experience: profile.selected_experience.slice(0, 4).map((e) => ({
      company: e.company ?? '',
      title: e.title ?? '',
      dates: formatDateRange(e.start_date, e.end_date),
    })),
    show_comp_logistics: !!fields.compLogistics.trim(),
    comp_logistics: fields.compLogistics.trim(),
    show_recruiter_notes: !!fields.recruiterNotes.trim(),
    recruiter_notes: fields.recruiterNotes.trim(),
  }
}

export function renderSubmittalDocx(
  templateBuffer: ArrayBuffer,
  renderData: SubmittalRenderData,
  logo: SubmittalLogo | null,
): ArrayBuffer {
  const zip = new PizZip(templateBuffer)

  // With no logo, leave the transparent placeholder in place so it renders empty.
  if (logo && logo.bytes.length > 0) {
    const [cx, cy] = logoEmu(logo.dims)
    injectLogo(zip, logo.bytes, cx, cy)
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  })

  doc.render(renderData)

  return doc.getZip().generate({ type: 'arraybuffer' })
}

export function exportSubmittal(
  templateBuffer: ArrayBuffer,
  renderData: SubmittalRenderData,
  logo: SubmittalLogo | null,
): Blob {
  return new Blob([renderSubmittalDocx(templateBuffer, renderData, logo)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}
