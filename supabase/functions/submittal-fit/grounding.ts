import type { FitResult } from './schema.ts'
import type { ParsedProfile } from '../resume-parse/schema.ts'

// Normalize text for numeric-grounding comparison: lowercase, drop $, commas, spaces.
function normalizeForNumbers(text: string): string {
  return text.toLowerCase().replace(/[$,\s]/g, '')
}

// Extract numeric tokens (with an optional trailing unit) from a piece of text,
// e.g. "$8M", "50m", "30%", "15+". Used to detect fabricated figures.
export function extractNumericTokens(text: string): string[] {
  const matches =
    text.toLowerCase().match(/\$?\d[\d,.]*\s?(?:%|k|m|b|bn|x|million|billion)?/g) ?? []
  return matches
    .map((m) => normalizeForNumbers(m).replace(/[.+]+$/, ''))
    .filter((m) => /\d/.test(m))
}

export function profileFactText(profile: ParsedProfile): string {
  return normalizeForNumbers(JSON.stringify(profile))
}

// Returns the list of numeric tokens that appear in the generated fit output but
// not anywhere in the candidate profile — i.e. likely hallucinated figures.
export function findUnsupportedNumbers(output: FitResult, profile: ParsedProfile): string[] {
  const haystack = profileFactText(profile)
  const texts = [
    output.fit_summary,
    ...output.fit_bullets.map((b) => b.text),
    ...output.key_qualifications.map((b) => b.text),
  ]
  const unsupported = new Set<string>()
  for (const text of texts) {
    for (const token of extractNumericTokens(text)) {
      if (!haystack.includes(token)) unsupported.add(token)
    }
  }
  return [...unsupported]
}
