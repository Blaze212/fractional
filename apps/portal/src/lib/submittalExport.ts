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
  keyQualifications: FitBullet[]
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
  show_key_qualifications: boolean
  key_qualifications: { text: string }[]
  recent_experience: { company: string; title: string; dates: string }[]
  show_comp_logistics: boolean
  comp_logistics_items: { text: string }[]
  show_recruiter_notes: boolean
  recruiter_notes_items: { text: string }[]
}

export type SubmittalLogo = { bytes: Uint8Array; dims: LogoDimensions }

function currentTitle(profile: ParsedProfile): string {
  return profile.current_title ?? profile.selected_experience[0]?.title ?? ''
}

// Each non-empty line in a multi-line text box becomes its own bullet point.
function linesToBullets(text: string): { text: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ text: line }))
}

export function mapToSubmittalRenderData(
  profile: ParsedProfile,
  fields: SubmittalFields,
): SubmittalRenderData {
  // The LLM selects the qualifications that actually support the JD; an empty
  // list is a valid "poor fit / no supporting points" signal, so we render it
  // as-is rather than padding it with unrelated profile highlights.
  const keyQualificationsSource = fields.keyQualifications.map((q) => q.text)

  const compLogisticsItems = linesToBullets(fields.compLogistics)
  const recruiterNotesItems = linesToBullets(fields.recruiterNotes)

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
    show_key_qualifications: keyQualificationsSource.length > 0,
    key_qualifications: keyQualificationsSource.map((text) => ({ text })),
    recent_experience: profile.selected_experience.slice(0, 4).map((e) => ({
      company: e.company ?? '',
      title: e.title ?? '',
      dates: formatDateRange(e.start_date, e.end_date),
    })),
    show_comp_logistics: compLogisticsItems.length > 0,
    comp_logistics_items: compLogisticsItems,
    show_recruiter_notes: recruiterNotesItems.length > 0,
    recruiter_notes_items: recruiterNotesItems,
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
