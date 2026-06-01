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
  show_current_title: boolean
  current_title: string
  show_candidate_location: boolean
  candidate_location: string
  show_work_authorization: boolean
  work_authorization: string
  show_total_experience: boolean
  total_experience: string
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

function currentTitle(profile: ParsedProfile): string {
  return profile.current_title ?? profile.selected_experience[0]?.title ?? ''
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
    show_current_title: !!currentTitle(profile),
    current_title: currentTitle(profile),
    show_candidate_location: !!(profile.location ?? '').trim(),
    candidate_location: profile.location ?? '',
    show_work_authorization: !!(profile.work_authorization ?? '').trim(),
    work_authorization: profile.work_authorization ?? '',
    show_total_experience: !!(profile.total_experience ?? '').trim(),
    total_experience: profile.total_experience ?? '',
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
