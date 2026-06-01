// Agency configuration for edge functions — mirrors apps/portal/src/lib/agencyConfig.ts.
// Keep the two files in sync when changing agency settings.

export interface AgencyEdgeConfig {
  identity: {
    name: string
  }
  llm: {
    fitNarrativeStyleGuide: string
    resumeParseNotes: string
  }
}

// ─────────────────────────────────────────────────────
// Tone extracted from the Employer Recruitment Branding Playbook:
//   Values-based, strategic, clear, organized, approachable.
//   "We make recruitment easy." — concise, confident, no fluff.

export const AGENCY_CONFIG: AgencyEdgeConfig = {
  identity: {
    name: 'Agency Name',
  },

  llm: {
    fitNarrativeStyleGuide: `
AGENCY VOICE:
- Write in a professional, values-grounded tone that is direct and efficient — no filler phrases, no superlatives unsupported by the profile.
- Lead with the candidate's clearest differentiator for this role, then support with specifics.
- Prefer precise, active language ("led a 12-person team" not "strong leadership background").
- Each bullet should read as a complete, standalone argument a hiring manager can absorb without re-reading the profile.
- Avoid recruiting clichés: "proven track record", "results-driven", "passionate", "dynamic", "seasoned".
- Keep sentences tight: one strong claim per sentence, two sentences per bullet maximum.
- The fit_summary should frame the candidate as a deliberate, aligned fit — not a generic strong candidate.
`.trim(),

    resumeParseNotes: '',
  },
}
