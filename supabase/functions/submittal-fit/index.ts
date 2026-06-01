import { withAuth, corsHeadersFor } from '../_shared/auth.ts'
import { logger } from '../_shared/logger.ts'
import { ValidationException, errorBody, logError } from '../_shared/errors.ts'
import { OpenAiResponsesClient } from '../_shared/ai-client.ts'
import { loadSupabaseAdminEnv } from '../_shared/env.ts'
import type { ParsedProfile } from '../resume-parse/schema.ts'
import { validateSubmittalInput, runFitGeneration } from './submittal-fit.ts'
import { trackUsageEvent } from '../_shared/track-usage.ts'

const DEFAULT_MODEL = 'gpt-5.4-mini'
const DEFAULT_GRADER_MODEL = 'gpt-5.4'

function getModel(): string {
  return (
    (typeof Deno !== 'undefined' ? Deno.env.get('SUBMITTAL_FIT_MODEL') : undefined) ?? DEFAULT_MODEL
  )
}

function getGraderModel(): string {
  return (
    (typeof Deno !== 'undefined' ? Deno.env.get('SUBMITTAL_FIT_GRADER_MODEL') : undefined) ??
    DEFAULT_GRADER_MODEL
  )
}

interface RawBody {
  parsed_profile?: ParsedProfile | null
  jd_text?: string | null
  client_name?: string | null
  role_title?: string | null
  fit_narrative_style_guide?: string | null
}

function jsonResponse(
  body: Record<string, object | string | number | boolean | null>,
  status: number,
  req: Request,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(
  withAuth(async (req, userId) => {
    const requestStart = performance.now()
    const log = logger.child({ userId })

    log.info(
      {
        method: req.method,
        content_length: req.headers.get('content-length') ?? undefined,
      },
      'submittal-fit: request received',
    )

    let body: RawBody
    try {
      body = (await req.json()) as RawBody
    } catch {
      const err = new ValidationException({ message: 'Request body must be valid JSON' })
      log.warn({ code: err.code }, 'submittal-fit: invalid JSON body')
      const status = err.status
      log.info(
        { status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'submittal-fit: handler complete',
      )
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        status,
        req,
      )
    }

    const validation = validateSubmittalInput(body)
    if (!validation.ok) {
      const err = new ValidationException({ message: validation.message })
      log.warn({ code: err.code }, 'submittal-fit: validation failed')
      const status = err.status
      log.info(
        { status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'submittal-fit: handler complete',
      )
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        status,
        req,
      )
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadSupabaseAdminEnv()
    const usageCtx = { userId, supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY }
    const aiClient = new OpenAiResponsesClient(getModel(), log)
    const graderAiClient = new OpenAiResponsesClient(getGraderModel(), log)

    try {
      const { result, grade, meta } = await runFitGeneration(
        validation.value,
        { aiClient, graderDeps: { graderAiClient } },
        log,
        usageCtx,
      )
      void trackUsageEvent(userId, 'submittal_fit', log)
      log.info(
        { status: 200, elapsed_ms: Math.round(performance.now() - requestStart) },
        'submittal-fit: handler complete',
      )
      return jsonResponse(
        {
          fit_bullets: result.fit_bullets,
          fit_summary: result.fit_summary,
          key_qualifications: result.key_qualifications,
          assessment: {
            fit_level: result.fit_level,
            jd_must_haves: result.jd_must_haves,
            must_have_coverage: result.must_have_coverage,
            gaps: result.internal_assessment.gaps,
          },
          grade,
          meta,
        } as Record<string, object | string | number | boolean | null>,
        200,
        req,
      )
    } catch (err) {
      const normalized = logError(
        err instanceof Error ? err : new Error(String(err)),
        'submittal-fit: failed',
        { userId },
        log,
      )
      log.info(
        { status: normalized.status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'submittal-fit: handler complete',
      )
      return jsonResponse(
        errorBody(normalized) as Record<string, object | string | number | boolean | null>,
        normalized.status,
        req,
      )
    }
  }),
)
