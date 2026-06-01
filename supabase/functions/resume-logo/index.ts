import { withAuth, corsHeadersFor, createUserClient, createAdminClient } from '../_shared/auth.ts'
import { logger } from '../_shared/logger.ts'
import {
  ValidationException,
  ResourceNotFoundException,
  InternalServiceException,
  errorBody,
  logError,
} from '../_shared/errors.ts'

const BUCKET = () =>
  (typeof Deno !== 'undefined' ? Deno.env.get('RESUME_LOGO_BUCKET') : undefined) ?? 'resume-logos'

// In local dev the storage client builds URLs using the internal Docker URL
// (kong:8000). Rewrite them to the public-facing URL so browsers can reach them.
function toPublicUrl(signedUrl: string): string {
  const internalBase =
    (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL') : undefined) ?? ''
  const publicBase =
    (typeof Deno !== 'undefined' ? Deno.env.get('PUBLIC_SUPABASE_URL') : undefined) ?? internalBase
  if (!internalBase || internalBase === publicBase) return signedUrl
  return signedUrl.replace(internalBase, publicBase)
}
const MAX_MB = () =>
  parseInt(
    (typeof Deno !== 'undefined' ? Deno.env.get('RESUME_LOGO_MAX_MB') : undefined) ?? '2',
    10,
  )
const SIGNED_URL_TTL = () =>
  parseInt(
    (typeof Deno !== 'undefined'
      ? Deno.env.get('RESUME_LOGO_SIGNED_URL_TTL_SECONDS')
      : undefined) ?? '120',
    10,
  )
const MAX_DIMENSION_PX = 2000
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg'])

type LogoMeta = {
  user_id: string
  storage_path: string
  mime_type: string
  width_px: number
  height_px: number
  file_size: number
  updated_at: string
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

async function handleGet(req: Request, userId: string): Promise<Response> {
  const log = logger.child({ userId, method: 'GET' })
  const adminClient = createAdminClient()

  const { data: meta, error } = await adminClient
    .from('user_resume_logo')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    const err = new InternalServiceException({ message: 'Failed to fetch logo metadata' })
    logError(err, 'resume-logo GET: db error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  if (!meta) {
    return jsonResponse({ logo: null }, 200, req)
  }

  const logoMeta = meta as LogoMeta
  const storageClient = createUserClient(req.headers.get('Authorization')?.slice(7) ?? '')
  const { data: signedUrl, error: urlError } = await storageClient.storage
    .from(BUCKET())
    .createSignedUrl(logoMeta.storage_path, SIGNED_URL_TTL())

  if (urlError || !signedUrl) {
    const err = new InternalServiceException({ message: 'Failed to generate signed URL' })
    logError(err, 'resume-logo GET: signed URL error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  log.info({ storagePath: logoMeta.storage_path }, 'resume-logo GET: returning logo')
  return jsonResponse(
    {
      logo: {
        signed_url: toPublicUrl(signedUrl.signedUrl),
        mime_type: logoMeta.mime_type,
        width_px: logoMeta.width_px,
        height_px: logoMeta.height_px,
        updated_at: logoMeta.updated_at,
      },
    },
    200,
    req,
  )
}

async function handlePost(req: Request, userId: string): Promise<Response> {
  const log = logger.child({ userId, method: 'POST' })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    const err = new ValidationException({ message: 'Request must be multipart/form-data' })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const fileEntry = formData.get('file')
  if (!(fileEntry instanceof File)) {
    const err = new ValidationException({ message: 'file field is required' })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const mimeType = fileEntry.type
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    const err = new ValidationException({
      message: `Unsupported file type: ${mimeType}. Only image/png and image/jpeg are allowed.`,
    })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const maxBytes = MAX_MB() * 1024 * 1024
  if (fileEntry.size > maxBytes) {
    const err = new ValidationException({
      message: `File exceeds ${MAX_MB()} MB limit (received ${fileEntry.size} bytes)`,
    })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const widthRaw = formData.get('width')
  const heightRaw = formData.get('height')
  const widthPx = typeof widthRaw === 'string' ? parseInt(widthRaw, 10) : NaN
  const heightPx = typeof heightRaw === 'string' ? parseInt(heightRaw, 10) : NaN

  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    const err = new ValidationException({
      message: 'width and height fields are required positive integers',
    })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  if (widthPx > MAX_DIMENSION_PX || heightPx > MAX_DIMENSION_PX) {
    const err = new ValidationException({
      message: `Image dimensions exceed ${MAX_DIMENSION_PX}px cap`,
    })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const storagePath = `${userId}/logo.${ext}`

  const arrayBuffer = await fileEntry.arrayBuffer()

  const storageClient = createUserClient(req.headers.get('Authorization')?.slice(7) ?? '')
  const { error: uploadError } = await storageClient.storage
    .from(BUCKET())
    .upload(storagePath, arrayBuffer, { contentType: mimeType, upsert: true })

  if (uploadError) {
    const err = new InternalServiceException({ message: 'Failed to upload logo' })
    logError(err, 'resume-logo POST: upload error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const adminClient = createAdminClient()
  const { error: upsertError } = await adminClient.from('user_resume_logo').upsert(
    {
      user_id: userId,
      storage_path: storagePath,
      mime_type: mimeType,
      width_px: widthPx,
      height_px: heightPx,
      file_size: fileEntry.size,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )

  if (upsertError) {
    const err = new InternalServiceException({ message: 'Failed to save logo metadata' })
    logError(err, 'resume-logo POST: upsert error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  log.info(
    { storagePath, mimeType, widthPx, heightPx, size: fileEntry.size },
    'resume-logo POST: uploaded',
  )
  return jsonResponse({ ok: true, storage_path: storagePath }, 200, req)
}

async function handleDelete(req: Request, userId: string): Promise<Response> {
  const log = logger.child({ userId, method: 'DELETE' })
  const adminClient = createAdminClient()

  const { data: meta, error: fetchError } = await adminClient
    .from('user_resume_logo')
    .select('storage_path')
    .eq('user_id', userId)
    .maybeSingle()

  if (fetchError) {
    const err = new InternalServiceException({ message: 'Failed to fetch logo metadata' })
    logError(err, 'resume-logo DELETE: fetch error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  if (!meta) {
    const err = new ResourceNotFoundException({ message: 'No logo configured' })
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const logoMeta = meta as { storage_path: string }
  const storageClient = createUserClient(req.headers.get('Authorization')?.slice(7) ?? '')
  const { error: removeError } = await storageClient.storage
    .from(BUCKET())
    .remove([logoMeta.storage_path])

  if (removeError) {
    const err = new InternalServiceException({ message: 'Failed to remove logo from storage' })
    logError(err, 'resume-logo DELETE: remove error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  const { error: deleteError } = await adminClient
    .from('user_resume_logo')
    .delete()
    .eq('user_id', userId)

  if (deleteError) {
    const err = new InternalServiceException({ message: 'Failed to delete logo metadata' })
    logError(err, 'resume-logo DELETE: delete meta error', { userId }, log)
    return jsonResponse(
      errorBody(err) as Record<string, object | string | number | boolean | null>,
      err.status,
      req,
    )
  }

  log.info({ storagePath: logoMeta.storage_path }, 'resume-logo DELETE: removed')
  return jsonResponse({ ok: true }, 200, req)
}

Deno.serve(
  withAuth(async (req, userId) => {
    const method = req.method.toUpperCase()

    if (method === 'GET') return handleGet(req, userId)
    if (method === 'POST') return handlePost(req, userId)
    if (method === 'DELETE') return handleDelete(req, userId)

    return new Response(
      JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }),
      {
        status: 405,
        headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
      },
    )
  }),
)
