import type { AiClient, TokenUsage } from '../_shared/ai-client.ts'
import type { LoggerLike } from '../_shared/logger.ts'
import { UnprocessableEntityException } from '../_shared/errors.ts'
import { logAiUsage } from '../_shared/log-ai-usage.ts'
import type { UsageContext } from '../_shared/log-ai-usage.ts'
import { PARSED_PROFILE_SCHEMA } from './schema.ts'
import type { ParsedProfile } from './schema.ts'
import { SYSTEM_PROMPT } from './system-prompt.ts'
import { buildResumeParsePrompt } from './prompt.ts'

export type { UsageContext }

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
  usageCtx: UsageContext,
): Promise<{ profile: ParsedProfile; meta: { model: string; input_char_count: number } }> {
  log.info({ input_char_count: resumeText.length }, 'resume-parse: starting')

  const prompt = buildResumeParsePrompt(resumeText)
  log.debug({ prompt_char_count: prompt.length }, 'resume-parse: prompt built')

  log.debug({ model: 'gpt', schema_name: 'parsed_profile' }, 'resume-parse: LLM call starting')

  let result: { data: ParsedProfile; tokens: TokenUsage }
  try {
    result = await deps.aiClient.completeJson<ParsedProfile>(
      SYSTEM_PROMPT,
      prompt,
      'parsed_profile',
      PARSED_PROFILE_SCHEMA,
    )
  } catch (err) {
    const errorModel = (deps.aiClient as { model?: string }).model ?? 'unknown'
    log.error({ err, model: errorModel }, 'resume-parse: LLM call failed')
    void logAiUsage(
      {
        supabaseUrl: usageCtx.supabaseUrl,
        serviceKey: usageCtx.serviceKey,
        userId: usageCtx.userId,
        feature: 'resume-parse',
        tokens: { input: 0, output: 0, latencyMs: 0 },
        success: false,
        errorCode: err instanceof Error ? err.constructor.name : 'LLM_ERROR',
      },
      log,
    )
    const message = err instanceof Error ? err.message : 'LLM call failed'
    throw new UnprocessableEntityException({ message: `Failed to parse resume: ${message}` })
  }

  const profile = result.data
  if (!profile || typeof profile !== 'object') {
    throw new UnprocessableEntityException({ message: 'LLM returned invalid profile structure' })
  }

  log.info(
    {
      model: result.tokens.model,
      input_tokens: result.tokens.input,
      output_tokens: result.tokens.output,
      latency_ms: result.tokens.latencyMs,
    },
    'resume-parse: LLM call complete',
  )

  void logAiUsage(
    {
      supabaseUrl: usageCtx.supabaseUrl,
      serviceKey: usageCtx.serviceKey,
      userId: usageCtx.userId,
      feature: 'resume-parse',
      tokens: result.tokens,
      success: true,
    },
    log,
  )

  return {
    profile,
    meta: {
      model: result.tokens.model ?? 'unknown',
      input_char_count: resumeText.length,
    },
  }
}
