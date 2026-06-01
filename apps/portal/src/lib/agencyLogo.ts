import { supabase } from './supabase'

export type LogoInfo = {
  signed_url: string
  mime_type: string
  width_px: number
  height_px: number
  updated_at: string
} | null

export async function fetchAgencyLogo(): Promise<LogoInfo> {
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
