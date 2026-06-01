import { withAuth, corsHeadersFor } from '../_shared/auth.ts'
import { logger } from '../_shared/logger.ts'
import { ValidationException, errorBody, logError } from '../_shared/errors.ts'
import { OpenAiResponsesClient } from '../_shared/ai-client.ts'
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
    const log = logger.child({ userId })

    let body: Record<string, string | null | undefined>
    try {
      body = (await req.json()) as Record<string, string | null | undefined>
    } catch {
      const err = new ValidationException({ message: 'Request body must be valid JSON' })
      log.warn({ code: err.code }, 'resume-parse: invalid JSON body')
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        err.status,
        req,
      )
    }

    const validation = validateResumeText(body['resume_text'])
    if (!validation.ok) {
      const err = new ValidationException({ message: validation.message })
      log.warn({ code: err.code }, 'resume-parse: validation failed')
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        err.status,
        req,
      )
    }

    const aiClient = new OpenAiResponsesClient(getModel(), log)

    try {
      const { profile, meta } = await runParsing(validation.text, { aiClient }, log)
      void trackUsageEvent(userId, 'resume_parse', log)
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
      return jsonResponse(
        errorBody(normalized) as Record<string, object | string | number | boolean | null>,
        normalized.status,
        req,
      )
    }
  }),
)
