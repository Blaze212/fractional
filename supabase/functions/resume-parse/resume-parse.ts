import type { AiClient } from '../_shared/ai-client.ts'
import type { LoggerLike } from '../_shared/logger.ts'
import { UnprocessableEntityException } from '../_shared/errors.ts'
import { PARSED_PROFILE_SCHEMA } from './schema.ts'
import type { ParsedProfile } from './schema.ts'
import { SYSTEM_PROMPT } from './system-prompt.ts'
import { buildResumeParsePrompt } from './prompt.ts'

export interface Deps {
  aiClient: AiClient
}

const DEFAULT_MAX_CHARS = 60_000

function getMaxChars(): number {
  const val = typeof Deno !== 'undefined' ? Deno.env.get('RESUME_PARSE_MAX_CHARS') : undefined
  if (!val) return DEFAULT_MAX_CHARS
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHARS
}

export function validateResumeText(
  raw: string | null | undefined,
): { ok: true; text: string } | { ok: false; message: string } {
  if (raw === null || raw === undefined || typeof raw !== 'string') {
    return { ok: false, message: 'resume_text is required' }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: 'resume_text must not be empty' }
  }
  const maxChars = getMaxChars()
  if (trimmed.length > maxChars) {
    return { ok: false, message: `resume_text exceeds ${maxChars} character limit` }
  }
  return { ok: true, text: trimmed }
}

export async function runParsing(
  resumeText: string,
  deps: Deps,
  log: LoggerLike,
): Promise<{ profile: ParsedProfile; meta: { model: string; input_char_count: number } }> {
  log.info({ input_char_count: resumeText.length }, 'resume-parse: starting LLM call')

  let result: { data: ParsedProfile; tokens: { input: number; output: number; model?: string } }
  try {
    result = await deps.aiClient.completeJson<ParsedProfile>(
      SYSTEM_PROMPT,
      buildResumeParsePrompt(resumeText),
      'parsed_profile',
      PARSED_PROFILE_SCHEMA,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LLM call failed'
    throw new UnprocessableEntityException({ message: `Failed to parse resume: ${message}` })
  }

  const profile = result.data
  if (!profile || typeof profile !== 'object') {
    throw new UnprocessableEntityException({ message: 'LLM returned invalid profile structure' })
  }

  log.info(
    {
      input_tokens: result.tokens.input,
      output_tokens: result.tokens.output,
      selected_count: profile.selected_experience?.length ?? 0,
      other_count: profile.other_experience?.length ?? 0,
    },
    'resume-parse: LLM call complete',
  )

  return {
    profile,
    meta: {
      model: result.tokens.model ?? 'unknown',
      input_char_count: resumeText.length,
    },
  }
}
