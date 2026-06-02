// Agency-level configuration — swap this file to rebrand the entire app,
// export output, and LLM tone for a different agency.

export interface AgencyConfig {
  identity: {
    name: string
  }
  brand: {
    // Hex values used in tailwind.config.ts and any inline styles
    primary: string // dark primary (text, headers, buttons)
    primaryLight: string // hover / active state
    secondary: string // accent / subheading color
    muted: string // light background tint
    // Text colors for use on brand backgrounds
    onPrimary: string
    onSecondary: string
  }
  export: {
    // Shown in the DOCX resume header line beneath the candidate's name
    sponsorshipText: string
    // Filename stem when the user downloads the generated submittal DOCX
    submittalFileStem: string // e.g. "{name}_for_{client}_submittal"
  }
  llm: {
    // Appended to the submittal-fit system prompt to inject agency voice.
    // Should describe tone, vocabulary, and any house-style constraints.
    fitNarrativeStyleGuide: string
    // Appended to the resume-parse system prompt. Usually empty unless the
    // agency parses resumes with domain-specific rules.
    resumeParseNotes: string
  }
}

// ─── Recruitment Agency ─────────────────────────────────────────────────────
// Colors sourced from alignedrecruitment.com Squarespace CSS variables:
//   --darkAccent-hsl:  201.29, 40.26%, 15.1%  → #172B36 (primary navy)
//   --accent-hsl:      201.18, 13.93%, 47.84% → #687E8A (steel blue-gray)
//   --lightAccent-hsl: 200,    40%,    94.12% → #EAF2F6 (light tint)
// Fonts: Lora (headings/body), Raleway 500 (subheadings), Candal (display)
// Tone extracted from the Employer Recruitment Branding Playbook:
//   Values-based, strategic, clear, organized, approachable.
//   "We make recruitment easy." — concise, confident, no fluff.

export const AGENCY_CONFIG: AgencyConfig = {
  identity: {
    name: 'Recruitment Agency',
  },

  brand: {
    primary: '#172B36',
    primaryLight: '#244455',
    secondary: '#687E8A',
    muted: '#EAF2F6',
    onPrimary: '#FFFFFF',
    onSecondary: '#FFFFFF',
  },

  export: {
    sponsorshipText: 'Authorized to work in the US without sponsorship',
    submittalFileStem: '{name}_for_{client}_submittal',
  },

  llm: {
    fitNarrativeStyleGuide: `
Agency voice: Recruitment Agency. Write in a professional, values-grounded tone that is direct and efficient — no filler phrases, no superlatives unsupported by the profile.

Style rules:
- Lead with the candidate's clearest differentiator for this role, then support with specifics.
- Prefer precise, active language over vague qualifiers ("led a 12-person team" > "strong leadership background").
- Each bullet should read as a complete, standalone argument — the hiring manager should not need to re-read the profile to understand why it matters.
- Avoid recruiting clichés: "proven track record", "results-driven", "passionate", "dynamic", "seasoned".
- Keep sentences tight: aim for one strong claim per sentence. Two sentences per bullet maximum.
- The summary sentence should frame the candidate as a deliberate, aligned fit — not a generic strong candidate.
`.trim(),

    resumeParseNotes: '',
  },
}
