import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import type { ParsedProfile } from './resumeTypes'

// @ts-expect-error — docxtemplater-image-module-free has no type declarations
import ImageModule from 'docxtemplater-image-module-free'

// 1px transparent PNG for the null-logo fallback
// This ensures {{%company_logo}} renders to nothing rather than throwing
const TRANSPARENT_1PX_PNG = (() => {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const binStr = atob(b64)
  const arr = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) arr[i] = binStr.charCodeAt(i)
  return arr
})()

const HEADER_WIDTH_PX = 120

export type RenderData = {
  name: string | null
  headerLine: string
  summary1: string
  summary2: string
  sponsorship: string
  careerHighlights: { bullet: string }[]
  selectedExperience: {
    company: string
    title: string
    dates: string
    responsibilities: { bullet: string }[]
    achievements: { bullet: string }[]
  }[]
  otherExperience: {
    company: string
    title: string
    dates: string
  }[]
  education: { institution: string; degree: string }[]
  certifications: { provider: string; certification: string }[]
  skillsLine: string
  toolsLine: string
  company_logo: Uint8Array
}

function formatDate(d: string | null | undefined): string {
  if (!d) return ''
  if (d === 'Present') return 'Present'
  // YYYY-MM → "Mon YYYY"
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

function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = formatDate(start)
  const e = formatDate(end)
  if (s && e) return `${s} – ${e}`
  if (s) return s
  return ''
}

export function mapParsedProfileToRenderData(
  profile: ParsedProfile,
  logoBytes: Uint8Array | null,
): RenderData {
  const headerParts = [profile.phone, profile.email, profile.location, profile.linkedin_url].filter(
    Boolean,
  )

  const [summary1 = '', summary2 = ''] = (profile.summary ?? '').split('\n\n')

  return {
    name: profile.name,
    headerLine: headerParts.join('  |  '),
    summary1,
    summary2,
    sponsorship: 'Authorized to work in the US without sponsorship',
    careerHighlights: profile.career_highlights.map((h) => ({ bullet: h })),
    selectedExperience: profile.selected_experience.map((exp) => ({
      company: exp.company ?? '',
      title: exp.title ?? '',
      dates: formatDateRange(exp.start_date, exp.end_date),
      responsibilities: exp.responsibilities.map((r) => ({ bullet: r })),
      achievements: exp.achievements.map((a) => ({ bullet: a })),
    })),
    otherExperience: profile.other_experience.map((exp) => ({
      company: exp.company ?? '',
      title: exp.title ?? '',
      dates: formatDateRange(exp.start_date, exp.end_date),
    })),
    education: profile.education.map((e) => ({
      institution: e.institution ?? '',
      degree: e.degree ?? '',
    })),
    certifications: profile.certifications.map((c) => ({
      provider: c.provider ?? '',
      certification: c.certification ?? '',
    })),
    skillsLine: profile.skills.join(', '),
    toolsLine: profile.tools.join(', '),
    company_logo: logoBytes ?? TRANSPARENT_1PX_PNG,
  }
}

export async function exportResume(
  templateBuffer: ArrayBuffer,
  renderData: RenderData,
): Promise<Blob> {
  const zip = new PizZip(templateBuffer)

  const imageModule = new ImageModule({
    centered: false,
    fileType: 'docx',
    getImage(tagValue: Uint8Array) {
      return tagValue
    },
    getSize(img: Uint8Array, _tagValue: Uint8Array, tagName: string) {
      if (tagName === 'company_logo') {
        const logoWidth = HEADER_WIDTH_PX
        // Use natural dimensions from renderData if available; otherwise square
        const naturalWidth = img.length > 100 ? HEADER_WIDTH_PX : HEADER_WIDTH_PX
        const ratio = logoWidth / naturalWidth
        return [logoWidth, Math.round(naturalWidth * ratio)] as [number, number]
      }
      return [HEADER_WIDTH_PX, HEADER_WIDTH_PX] as [number, number]
    },
  })

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
    modules: [imageModule],
  })

  doc.render(renderData)

  const out = doc.getZip().generate({ type: 'arraybuffer' })
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}
