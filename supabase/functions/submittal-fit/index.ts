import { withAuth, corsHeadersFor } from '../_shared/auth.ts'
import { logger } from '../_shared/logger.ts'
import { ValidationException, errorBody, logError } from '../_shared/errors.ts'
import { OpenAiResponsesClient } from '../_shared/ai-client.ts'
import type { ParsedProfile } from '../resume-parse/schema.ts'
import { validateSubmittalInput, runFitGeneration } from './submittal-fit.ts'

const DEFAULT_MODEL = 'gpt-5.4-mini'

function getModel(): string {
  return (
    (typeof Deno !== 'undefined' ? Deno.env.get('SUBMITTAL_FIT_MODEL') : undefined) ?? DEFAULT_MODEL
  )
}

interface RawBody {
  parsed_profile?: ParsedProfile | null
  jd_text?: string | null
  client_name?: string | null
  role_title?: string | null
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

    let body: RawBody
    try {
      body = (await req.json()) as RawBody
    } catch {
      const err = new ValidationException({ message: 'Request body must be valid JSON' })
      log.warn({ code: err.code }, 'submittal-fit: invalid JSON body')
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        err.status,
        req,
      )
    }

    const validation = validateSubmittalInput(body)
    if (!validation.ok) {
      const err = new ValidationException({ message: validation.message })
      log.warn({ code: err.code }, 'submittal-fit: validation failed')
      return jsonResponse(
        errorBody(err) as Record<string, object | string | number | boolean | null>,
        err.status,
        req,
      )
    }

    const aiClient = new OpenAiResponsesClient(getModel(), log)

    try {
      const { result, meta } = await runFitGeneration(validation.value, { aiClient }, log)
      return jsonResponse(
        { fit_bullets: result.fit_bullets, fit_summary: result.fit_summary, meta } as Record<
          string,
          object | string | number | boolean | null
        >,
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
      return jsonResponse(
        errorBody(normalized) as Record<string, object | string | number | boolean | null>,
        normalized.status,
        req,
      )
    }
  }),
)
