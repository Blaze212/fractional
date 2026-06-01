import type { AiClient, TokenUsage } from '../_shared/ai-client.ts'
import type { LoggerLike } from '../_shared/logger.ts'
import { UnprocessableEntityException } from '../_shared/errors.ts'
import { logAiUsage } from '../_shared/log-ai-usage.ts'
import type { UsageContext } from '../_shared/log-ai-usage.ts'
import type { ParsedProfile } from '../resume-parse/schema.ts'
import { FIT_RESULT_SCHEMA } from './schema.ts'
import type { FitResult } from './schema.ts'
import type { FitGrade, GraderDeps } from './fit-grader.ts'
import { gradeFit } from './fit-grader.ts'
import { buildSubmittalSystemPrompt } from './system-prompt.ts'
import { buildSubmittalPrompt } from './prompt.ts'
import { extractNumericTokens, profileFactText, findUnsupportedNumbers } from './grounding.ts'

// Re-export grounding utilities so existing callers (tests, eval harness) keep working.
export { extractNumericTokens, profileFactText, findUnsupportedNumbers }
export type { UsageContext }

export interface Deps {
  aiClient: AiClient
  graderDeps?: GraderDeps
}

export interface SubmittalInput {
  parsed_profile: ParsedProfile
  jd_text: string
  client_name: string
  role_title: string
  // Agency voice injected into the system prompt. Optional: when omitted the
  // function falls back to the built-in default in system-prompt.ts.
  fit_narrative_style_guide?: string
}

interface RawBody {
  parsed_profile?: ParsedProfile | null
  jd_text?: string | null
  client_name?: string | null
  role_title?: string | null
  fit_narrative_style_guide?: string | null
}

const MAX_JD_CHARS = 40_000
const MAX_STYLE_GUIDE_CHARS = 10_000

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

  let styleGuide: string | undefined
  const rawGuide = body.fit_narrative_style_guide
  if (rawGuide !== undefined && rawGuide !== null) {
    if (typeof rawGuide !== 'string') {
      return { ok: false, message: 'fit_narrative_style_guide must be a string' }
    }
    if (rawGuide.length > MAX_STYLE_GUIDE_CHARS) {
      return {
        ok: false,
        message: `fit_narrative_style_guide exceeds ${MAX_STYLE_GUIDE_CHARS} character limit`,
      }
    }
    styleGuide = rawGuide
  }

  return {
    ok: true,
    value: {
      parsed_profile: body.parsed_profile,
      jd_text: jd,
      client_name: clientName,
      role_title: roleTitle,
      fit_narrative_style_guide: styleGuide,
    },
  }
}

async function callGenerator(
  input: SubmittalInput,
  aiClient: AiClient,
  log: LoggerLike,
  usageCtx: UsageContext,
  attempt: number,
): Promise<{ result: FitResult; model: string; tokens: TokenUsage }> {
  log.info(
    {
      client: input.client_name,
      role: input.role_title,
      jd_char_count: input.jd_text.length,
      attempt,
    },
    'submittal-fit: generator call starting',
  )

  let res: { data: FitResult; tokens: TokenUsage }
  try {
    res = await aiClient.completeJson<FitResult>(
      buildSubmittalSystemPrompt(input.fit_narrative_style_guide),
      buildSubmittalPrompt(input),
      'submittal_fit',
      FIT_RESULT_SCHEMA,
    )
  } catch (err) {
    const model = (aiClient as { model?: string }).model ?? 'unknown'
    log.error({ err, model, attempt }, 'submittal-fit: LLM call failed')
    void logAiUsage(
      {
        supabaseUrl: usageCtx.supabaseUrl,
        serviceKey: usageCtx.serviceKey,
        userId: usageCtx.userId,
        feature: 'submittal-fit',
        tokens: { input: 0, output: 0, latencyMs: 0 },
        success: false,
        errorCode: err instanceof Error ? err.constructor.name : 'LLM_ERROR',
      },
      log,
    )
    const message = err instanceof Error ? err.message : 'LLM call failed'
    throw new UnprocessableEntityException({
      message: `Failed to generate fit narrative: ${message}`,
    })
  }

  const result = res.data

  // Shape validation — these are contract violations, always throw.
  if (!result || !Array.isArray(result.fit_bullets) || result.fit_bullets.length !== 3) {
    log.error(
      { reason: 'fit_bullets count != 3', attempt },
      'submittal-fit: shape validation failed',
    )
    throw new UnprocessableEntityException({
      message: 'Fit generation must return exactly 3 bullets',
    })
  }
  if (typeof result.fit_summary !== 'string' || result.fit_summary.trim().length === 0) {
    log.error({ reason: 'empty fit_summary', attempt }, 'submittal-fit: shape validation failed')
    throw new UnprocessableEntityException({ message: 'Fit generation returned an empty summary' })
  }
  if (!Array.isArray(result.key_qualifications) || result.key_qualifications.length > 5) {
    log.error(
      { reason: 'key_qualifications > 5', attempt },
      'submittal-fit: shape validation failed',
    )
    throw new UnprocessableEntityException({
      message: 'Fit generation must return at most 5 key qualifications',
    })
  }

  log.info(
    {
      model: res.tokens.model,
      input_tokens: res.tokens.input,
      output_tokens: res.tokens.output,
      latency_ms: res.tokens.latencyMs,
      attempt,
    },
    'submittal-fit: generator call complete',
  )

  void logAiUsage(
    {
      supabaseUrl: usageCtx.supabaseUrl,
      serviceKey: usageCtx.serviceKey,
      userId: usageCtx.userId,
      feature: 'submittal-fit',
      tokens: res.tokens,
      success: true,
    },
    log,
  )

  return { result, model: res.tokens.model ?? 'unknown', tokens: res.tokens }
}

const DEFAULT_SHIP_GRADE: FitGrade = {
  action: 'ship',
  failure_class: 'none',
  issues: [],
  warnings: [],
}

export async function runFitGeneration(
  input: SubmittalInput,
  deps: Deps,
  log: LoggerLike,
  usageCtx: UsageContext,
): Promise<{ result: FitResult; grade: FitGrade; meta: { model: string } }> {
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let callCount = 0

  const { result, model, tokens } = await callGenerator(input, deps.aiClient, log, usageCtx, 1)
  totalInputTokens += tokens.input
  totalOutputTokens += tokens.output
  callCount++

  // No grader injected — return default ship grade (Phase 1 / grader-disabled path).
  if (!deps.graderDeps) {
    log.info(
      { grade_action: 'ship', failure_class: 'none', issue_count: 0, warning_count: 0 },
      'submittal-fit: final grade',
    )
    log.info(
      {
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        call_count: callCount,
      },
      'submittal-fit: token summary',
    )
    return { result, grade: DEFAULT_SHIP_GRADE, meta: { model } }
  }

  // Phase 2: run grader with conditional Layer 2 and auto-regenerate on hallucination.
  let grade = await gradeFit(input, result, deps.graderDeps, log, usageCtx)

  if (grade.action === 'regenerate') {
    log.warn(
      { issues: grade.issues, attempt: 1 },
      'submittal-fit: hallucination detected — auto-regenerating',
    )
    try {
      const {
        result: retryResult,
        model: retryModel,
        tokens: retryTokens,
      } = await callGenerator(input, deps.aiClient, log, usageCtx, 2)
      totalInputTokens += retryTokens.input
      totalOutputTokens += retryTokens.output
      callCount++

      const retryGrade = await gradeFit(input, retryResult, deps.graderDeps, log, usageCtx)
      if (retryGrade.action === 'regenerate') {
        // Second attempt still hallucinating — fail safe, never throw.
        grade = {
          action: 'human_review',
          failure_class: 'hallucination',
          issues: retryGrade.issues,
          warnings: ['Auto-regeneration did not resolve hallucination'],
        }
      } else {
        log.info(
          {
            grade_action: retryGrade.action,
            failure_class: retryGrade.failure_class,
            issue_count: retryGrade.issues.length,
            warning_count: retryGrade.warnings.length,
          },
          'submittal-fit: final grade',
        )
        log.info(
          {
            total_input_tokens: totalInputTokens,
            total_output_tokens: totalOutputTokens,
            call_count: callCount,
          },
          'submittal-fit: token summary',
        )
        return { result: retryResult, grade: retryGrade, meta: { model: retryModel } }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ err: msg, attempt: 2 }, 'submittal-fit: auto-regeneration failed')
      grade = {
        action: 'human_review',
        failure_class: 'hallucination',
        issues: grade.issues,
        warnings: ['Auto-regeneration failed; manual review required'],
      }
    }
  }

  log.info(
    {
      grade_action: grade.action,
      failure_class: grade.failure_class,
      issue_count: grade.issues.length,
      warning_count: grade.warnings.length,
    },
    'submittal-fit: final grade',
  )
  log.info(
    {
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      call_count: callCount,
    },
    'submittal-fit: token summary',
  )

  return { result, grade, meta: { model } }
}
