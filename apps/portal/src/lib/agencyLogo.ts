import { supabase } from './supabase'

export type LogoInfo = {
  signed_url: string
  mime_type: string
  width_px: number
  height_px: number
  updated_at: string
} | null

// The logo downloaded once and held in memory: `url` is a blob object URL for
// rendering (no expiry, valid for the session) and `bytes` are reused on export.
export type CachedLogo = {
  url: string
  bytes: Uint8Array
  mimeType: string
  widthPx: number
  heightPx: number
}

async function fetchLogoMeta(): Promise<LogoInfo> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) return null

  const json = (await res.json()) as { logo: LogoInfo }
  return json.logo
}

// Resolve the logo's (short-lived) signed URL, download the bytes immediately,
// and cache them as a blob object URL so nothing later depends on the signed
// URL still being valid.
export async function loadAgencyLogo(): Promise<CachedLogo | null> {
  const meta = await fetchLogoMeta()
  if (!meta) return null

  const res = await fetch(meta.signed_url)
  if (!res.ok) return null

  const blob = await res.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return {
    url: URL.createObjectURL(blob),
    bytes,
    mimeType: meta.mime_type,
    widthPx: meta.width_px,
    heightPx: meta.height_px,
  }
}
