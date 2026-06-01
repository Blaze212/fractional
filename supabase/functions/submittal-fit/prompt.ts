import type { ParsedProfile } from '../resume-parse/schema.ts'
import type { SubmittalInput } from './submittal-fit.ts'

function serializeProfile(profile: ParsedProfile): string {
  const lines: string[] = []

  lines.push(`name: ${profile.name ?? ''}`)
  lines.push(`seniority_level: ${profile.seniority_level ?? ''}`)
  if (profile.current_title) lines.push(`current_title: ${profile.current_title}`)
  if (profile.total_experience) lines.push(`total_experience: ${profile.total_experience}`)
  if (profile.summary) lines.push(`summary: ${profile.summary}`)

  profile.career_highlights.forEach((h, i) => {
    lines.push(`career_highlights[${i}]: ${h}`)
  })

  profile.selected_experience.forEach((exp, i) => {
    const header = [exp.title, exp.company].filter(Boolean).join(' at ')
    const dates = [exp.start_date, exp.end_date].filter(Boolean).join(' – ')
    lines.push(`selected_experience[${i}]: ${header}${dates ? ` (${dates})` : ''}`)
    exp.responsibilities.forEach((r) => lines.push(`  - responsibility: ${r}`))
    exp.achievements.forEach((a) => lines.push(`  - achievement: ${a}`))
  })

  if (profile.functional_areas.length)
    lines.push(`functional_areas: ${profile.functional_areas.join(', ')}`)
  if (profile.industries.length) lines.push(`industries: ${profile.industries.join(', ')}`)
  if (profile.skills.length) lines.push(`skills: ${profile.skills.join(', ')}`)
  if (profile.tools.length) lines.push(`tools: ${profile.tools.join(', ')}`)

  return lines.join('\n')
}

export function buildSubmittalPrompt(input: SubmittalInput): string {
  return `Write the candidate submittal fit narrative.

---CLIENT---
${input.client_name}

---ROLE---
${input.role_title}

---JOB DESCRIPTION (verbatim from client; use to tailor, not as candidate facts)---
${input.jd_text}

---CANDIDATE PROFILE (the ONLY source of candidate facts you may use)---
${serializeProfile(input.parsed_profile)}
---END CANDIDATE PROFILE---`
}
