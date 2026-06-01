import type { AiClient } from '../_shared/ai-client.ts'
import type { LoggerLike } from '../_shared/logger.ts'
import { UnprocessableEntityException } from '../_shared/errors.ts'
import type { ParsedProfile } from '../resume-parse/schema.ts'
import { FIT_RESULT_SCHEMA } from './schema.ts'
import type { FitResult } from './schema.ts'
import { SUBMITTAL_SYSTEM_PROMPT } from './system-prompt.ts'
import { buildSubmittalPrompt } from './prompt.ts'

export interface Deps {
  aiClient: AiClient
}

export interface SubmittalInput {
  parsed_profile: ParsedProfile
  jd_text: string
  client_name: string
  role_title: string
}

interface RawBody {
  parsed_profile?: ParsedProfile | null
  jd_text?: string | null
  client_name?: string | null
  role_title?: string | null
}

const MAX_JD_CHARS = 40_000

function isParsedProfile(value: ParsedProfile | null | undefined): value is ParsedProfile {
  if (!value || typeof value !== 'object') return false
  return (
    Array.isArray(value.selected_experience) &&
    Array.isArray(value.career_highlights) &&
    Array.isArray(value.skills)
  )
}

function requireText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function validateSubmittalInput(
  body: RawBody,
): { ok: true; value: SubmittalInput } | { ok: false; message: string } {
  if (!isParsedProfile(body.parsed_profile)) {
    return { ok: false, message: 'parsed_profile is required and must be a parsed resume profile' }
  }

  const jd = requireText(body.jd_text)
  if (!jd) return { ok: false, message: 'jd_text is required' }
  if (jd.length > MAX_JD_CHARS) {
    return { ok: false, message: `jd_text exceeds ${MAX_JD_CHARS} character limit` }
  }

  const clientName = requireText(body.client_name)
  if (!clientName) return { ok: false, message: 'client_name is required' }

  const roleTitle = requireText(body.role_title)
  if (!roleTitle) return { ok: false, message: 'role_title is required' }

  return {
    ok: true,
    value: {
      parsed_profile: body.parsed_profile,
      jd_text: jd,
      client_name: clientName,
      role_title: roleTitle,
    },
  }
}

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
  const texts = [output.fit_summary, ...output.fit_bullets.map((b) => b.text)]
  const unsupported = new Set<string>()
  for (const text of texts) {
    for (const token of extractNumericTokens(text)) {
      if (!haystack.includes(token)) unsupported.add(token)
    }
  }
  return [...unsupported]
}

export async function runFitGeneration(
  input: SubmittalInput,
  deps: Deps,
  log: LoggerLike,
): Promise<{ result: FitResult; meta: { model: string } }> {
  log.info(
    { client: input.client_name, role: input.role_title, jd_char_count: input.jd_text.length },
    'submittal-fit: starting LLM call',
  )

  let res: { data: FitResult; tokens: { input: number; output: number; model?: string } }
  try {
    res = await deps.aiClient.completeJson<FitResult>(
      SUBMITTAL_SYSTEM_PROMPT,
      buildSubmittalPrompt(input),
      'submittal_fit',
      FIT_RESULT_SCHEMA,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LLM call failed'
    throw new UnprocessableEntityException({
      message: `Failed to generate fit narrative: ${message}`,
    })
  }

  const result = res.data
  if (!result || !Array.isArray(result.fit_bullets) || result.fit_bullets.length !== 3) {
    throw new UnprocessableEntityException({
      message: 'Fit generation must return exactly 3 bullets',
    })
  }
  if (typeof result.fit_summary !== 'string' || result.fit_summary.trim().length === 0) {
    throw new UnprocessableEntityException({ message: 'Fit generation returned an empty summary' })
  }

  const unsupported = findUnsupportedNumbers(result, input.parsed_profile)
  if (unsupported.length > 0) {
    log.warn({ unsupported }, 'submittal-fit: ungrounded figures detected in fit output')
    throw new UnprocessableEntityException({
      message: `Generated fit narrative contained figures not present in the resume: ${unsupported.join(', ')}. Please regenerate.`,
    })
  }

  log.info(
    { input_tokens: res.tokens.input, output_tokens: res.tokens.output },
    'submittal-fit: LLM call complete',
  )

  return { result, meta: { model: res.tokens.model ?? 'unknown' } }
}
