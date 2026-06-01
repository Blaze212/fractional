import { withAuth, corsHeadersFor } from '../_shared/auth.ts'
import { logger } from '../_shared/logger.ts'
import { ValidationException, errorBody, logError } from '../_shared/errors.ts'
import { OpenAiResponsesClient } from '../_shared/ai-client.ts'
import { loadSupabaseAdminEnv } from '../_shared/env.ts'
import { validateResumeText, runParsing } from './resume-parse.ts'
import { trackUsageEvent } from '../_shared/track-usage.ts'

const DEFAULT_MODEL = 'gpt-5.4-mini'

function getModel(): string {
  return (
    (typeof Deno !== 'undefined' ? Deno.env.get('RESUME_PARSE_MODEL') : undefined) ?? DEFAULT_MODEL
  )
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
      'resume-parse: request received',
    )

    let body: Record<string, string | null | undefined>
    try {
      body = (await req.json()) as Record<string, string | null | undefined>
    } catch {
      const err = new ValidationException({ message: 'Request body must be valid JSON' })
      log.warn({ code: err.code }, 'resume-parse: invalid JSON body')
      const status = err.status
      log.info(
        { status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'resume-parse: handler complete',
      )
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        status,
        req,
      )
    }

    const validation = validateResumeText(body['resume_text'])
    if (!validation.ok) {
      const err = new ValidationException({ message: validation.message })
      log.warn({ code: err.code }, 'resume-parse: validation failed')
      const status = err.status
      log.info(
        { status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'resume-parse: handler complete',
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

    try {
      const { profile, meta } = await runParsing(validation.text, { aiClient }, log, usageCtx)
      void trackUsageEvent(userId, 'resume_parse', log)
      log.info(
        { status: 200, elapsed_ms: Math.round(performance.now() - requestStart) },
        'resume-parse: handler complete',
      )
      return jsonResponse(
        { profile, meta } as Record<string, object | string | number | boolean | null>,
        200,
        req,
      )
    } catch (err) {
      const normalized = logError(
        err instanceof Error ? err : new Error(String(err)),
        'resume-parse: failed',
        { userId },
        log,
      )
      log.info(
        { status: normalized.status, elapsed_ms: Math.round(performance.now() - requestStart) },
        'resume-parse: handler complete',
      )
      return jsonResponse(
        errorBody(normalized) as Record<string, object | string | number | boolean | null>,
        normalized.status,
        req,
      )
    }
  }),
)
