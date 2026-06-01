import { createClient } from '@supabase/supabase-js'
import {
  AccessDeniedException,
  InternalServiceException,
  errorBody,
  normalizeError,
} from './errors.ts'
import { logger } from './logger.ts'
import { loadSupabaseUserEnv } from './env.ts'

const CORS_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type'
const ALLOWED_ORIGINS = [
  'https://app.fractional.io',
  'http://localhost:5183',
  'http://localhost:5173',
  'http://localhost:4173',
]

function getAllowedOrigins(): Set<string> {
  const extraOrigins =
    (typeof Deno !== 'undefined' ? Deno.env.get('FRACTIONAL_ALLOWED_ORIGINS') : undefined)
      ?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? []
  return new Set([...ALLOWED_ORIGINS, ...extraOrigins])
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowedOrigin = getAllowedOrigins().has(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    Vary: 'Origin',
  }
}

function jsonResponse(
  body: Record<string, object | string | number | boolean | null>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function withRequestCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeadersFor(req))) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function jsonErrorResponse(error: AppException): Response {
  return jsonResponse(
    errorBody(error) as Record<string, object | string | number | boolean | null>,
    error.status,
  )
}

import type { AppException } from './errors.ts'

async function authenticateRequest(
  req: Request,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    const err = new AccessDeniedException({ message: 'Missing bearer token' })
    logger.warn({ code: err.code }, 'Authorization header missing bearer token')
    return { ok: false, response: jsonErrorResponse(err) }
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    const err = new AccessDeniedException({ message: 'Empty bearer token' })
    return { ok: false, response: jsonErrorResponse(err) }
  }

  let env: ReturnType<typeof loadSupabaseUserEnv>
  try {
    env = loadSupabaseUserEnv()
  } catch (sourceError) {
    const err = new InternalServiceException({ message: 'Server auth misconfigured' })
    logger.error({ sourceError }, 'Auth misconfiguration')
    return { ok: false, response: jsonErrorResponse(err) }
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    const err = new AccessDeniedException({ message: 'Invalid or expired token' })
    logger.warn({ code: err.code }, 'Token validation failed')
    return { ok: false, response: jsonErrorResponse(err) }
  }

  return { ok: true, userId: data.user.id }
}

export function withAuth(
  handler: (req: Request, userId: string) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeadersFor(req) })
    }

    const authResult = await authenticateRequest(req)
    if (!authResult.ok) return withRequestCors(req, authResult.response)

    try {
      const response = await handler(req, authResult.userId)
      return withRequestCors(req, response)
    } catch (err) {
      const normalized = normalizeError(err instanceof Error ? err : new Error(String(err)))
      return withRequestCors(req, jsonErrorResponse(normalized))
    }
  }
}

export function createUserClient(token: string) {
  const env = loadSupabaseUserEnv()
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

export function createAdminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? '',
    SUPABASE_SERVICE_ROLE_KEY:
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || '',
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}
