import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import type { ParsedProfile } from './resumeTypes'
import { injectLogo, logoEmu } from './docxLogo'
import type { LogoDimensions } from './docxLogo'
import { AGENCY_CONFIG } from './agencyConfig'

export type { LogoDimensions } from './docxLogo'

export type RenderData = {
  company_logo: Uint8Array
  name: string
  headerLine: string
  sponsorship: string
  showSummary: boolean
  summaryParagraph1: string
  summaryParagraph2: string
  showCareerHighlights: boolean
  careerHighlights: { text: string }[]
  selectedExperience: {
    company: string
    title: string
    dates: string
    showResponsibilities: boolean
    responsibilities: { text: string }[]
    showAchievements: boolean
    achievements: { text: string }[]
  }[]
  showOtherExperience: boolean
  otherExperience: { text: string }[]
  showEducationCertifications: boolean
  education: { text: string }[]
  certifications: { text: string }[]
  showSkillsTools: boolean
  skillsLine: string
  toolsLine: string
}

function formatDate(d: string | null | undefined): string {
  if (!d) return ''
  if (d === 'Present') return 'Present'
  const match = /^(\d{4})-(\d{2})$/.exec(d)
  if (!match) return d
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const month = months[parseInt(match[2], 10) - 1] ?? ''
  return `${month} ${match[1]}`
}

export function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  const s = formatDate(start)
  const e = formatDate(end)
  if (s && e) return `${s} – ${e}`
  if (s) return s
  return ''
}

export function mapParsedProfileToRenderData(
  profile: ParsedProfile,
  logoBytes: Uint8Array,
): RenderData {
  const headerParts = [profile.phone, profile.email, profile.location, profile.linkedin_url].filter(
    Boolean,
  )
  const [summaryParagraph1 = '', summaryParagraph2 = ''] = (profile.summary ?? '').split('\n\n')
  const careerHighlights = profile.career_highlights.map((h) => ({ text: h }))
  const otherExperience = profile.other_experience.map((exp) => {
    const parts = [exp.company, exp.title].filter(Boolean).join(' — ')
    const dates = formatDateRange(exp.start_date, exp.end_date)
    return { text: dates ? `${parts}  |  ${dates}` : parts }
  })
  const education = profile.education.map((e) => ({
    text: [e.institution, e.degree].filter(Boolean).join(' — '),
  }))
  const certifications = profile.certifications.map((c) => ({
    text: [c.provider, c.certification].filter(Boolean).join(' — '),
  }))

  return {
    company_logo: logoBytes,
    name: profile.name ?? '',
    headerLine: headerParts.join('  |  '),
    sponsorship: AGENCY_CONFIG.export.sponsorshipText,
    showSummary: !!summaryParagraph1,
    summaryParagraph1,
    summaryParagraph2,
    showCareerHighlights: careerHighlights.length > 0,
    careerHighlights,
    selectedExperience: profile.selected_experience.map((exp) => {
      const responsibilities = exp.responsibilities.map((r) => ({ text: r }))
      const achievements = exp.achievements.map((a) => ({ text: a }))
      return {
        company: exp.company ?? '',
        title: exp.title ?? '',
        dates: formatDateRange(exp.start_date, exp.end_date),
        showResponsibilities: responsibilities.length > 0,
        responsibilities,
        showAchievements: achievements.length > 0,
        achievements,
      }
    }),
    showOtherExperience: otherExperience.length > 0,
    otherExperience,
    showEducationCertifications: education.length > 0 || certifications.length > 0,
    education,
    certifications,
    showSkillsTools: profile.skills.length > 0 || profile.tools.length > 0,
    skillsLine: profile.skills.join(', '),
    toolsLine: profile.tools.join(', '),
  }
}

export async function exportResume(
  templateBuffer: ArrayBuffer,
  renderData: RenderData,
  logoDims: LogoDimensions,
): Promise<Blob> {
  const [logoCx, logoCy] = logoEmu(logoDims)

  const zip = new PizZip(templateBuffer)

  // Swap placeholder image bytes and update extent — no image module needed
  injectLogo(zip, renderData.company_logo, logoCx, logoCy)

  // Render text tags (company_logo is no longer a tag in the template)
  const { company_logo: _logo, ...textData } = renderData
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  })

  doc.render(textData)

  const out = doc.getZip().generate({ type: 'arraybuffer' })
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}
