import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { ParsedProfile } from '../lib/resumeTypes'
import { mapParsedProfileToRenderData, exportResume } from '../lib/resumeExport'

type PageState = 'idle' | 'generating' | 'success' | 'error'

type LogoInfo = {
  signed_url: string
  mime_type: string
  width_px: number
  height_px: number
  updated_at: string
} | null

const ESTIMATE_SECONDS = 60

function ProgressBar({ elapsed }: { elapsed: number }) {
  // Approaches but never reaches 100% while in-flight
  const progress = Math.min(95, (elapsed / ESTIMATE_SECONDS) * 100)
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm text-slate-500">
        <span>Parsing resume…</span>
        <span>
          {elapsed < ESTIMATE_SECONDS
            ? `~${Math.max(0, ESTIMATE_SECONDS - elapsed)}s remaining`
            : 'Still working…'}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-brand transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}

function ProfileSummary({ profile }: { profile: ParsedProfile }) {
  const roleCount =
    profile.selected_experience.length + profile.other_experience.length
  const topCompanies = profile.selected_experience
    .slice(0, 3)
    .map((e) => e.company)
    .filter(Boolean)
    .join(', ')

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">{profile.name ?? 'Unknown'}</h2>
        {profile.seniority_level && (
          <span className="mt-1 inline-block rounded-full bg-brand-muted px-3 py-0.5 text-xs font-semibold text-brand">
            {profile.seniority_level}
          </span>
        )}
      </div>

      {profile.summary && (
        <p className="text-sm leading-relaxed text-slate-600">{profile.summary.slice(0, 300)}{profile.summary.length > 300 ? '…' : ''}</p>
      )}

      <div className="grid grid-cols-2 gap-4 text-sm text-slate-600">
        <div>
          <span className="font-medium text-slate-900">Roles:</span> {roleCount}
        </div>
        {topCompanies && (
          <div>
            <span className="font-medium text-slate-900">Companies:</span> {topCompanies}
          </div>
        )}
        {profile.functional_areas.length > 0 && (
          <div>
            <span className="font-medium text-slate-900">Focus:</span>{' '}
            {profile.functional_areas.slice(0, 3).join(', ')}
          </div>
        )}
        {profile.industries.length > 0 && (
          <div>
            <span className="font-medium text-slate-900">Industries:</span>{' '}
            {profile.industries.slice(0, 3).join(', ')}
          </div>
        )}
      </div>

      {profile.skills.length > 0 && (
        <div className="text-sm text-slate-600">
          <span className="font-medium text-slate-900">Skills: </span>
          {profile.skills.slice(0, 8).join(', ')}
        </div>
      )}
    </div>
  )
}

function LogoUploader({
  logo,
  onLogoChange,
  disabled,
}: {
  logo: LogoInfo
  onLogoChange: (logo: LogoInfo) => void
  disabled: boolean
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function fetchLogo() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`,
      { headers: { Authorization: `Bearer ${session.access_token}` } },
    )
    if (res.ok) {
      const json = (await res.json()) as { logo: LogoInfo }
      onLogoChange(json.logo)
    }
  }

  useEffect(() => {
    fetchLogo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)
    setUploading(true)

    try {
      // Measure dimensions client-side before uploading
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image()
        const url = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: img.naturalWidth, height: img.naturalHeight })
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('Failed to load image'))
        }
        img.src = url
      })

      const form = new FormData()
      form.append('file', file)
      form.append('width', String(dimensions.width))
      form.append('height', String(dimensions.height))

      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: form,
        },
      )

      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } }
        throw new Error(err.error?.message ?? 'Upload failed')
      }

      await fetchLogo()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemove() {
    setError(null)
    setUploading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      )
      if (!res.ok) throw new Error('Remove failed')
      onLogoChange(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-700">Company Logo</label>
      <div className="flex items-center gap-4">
        {logo ? (
          <>
            <img
              src={logo.signed_url}
              alt="Company logo"
              className="h-12 max-w-[120px] rounded border border-slate-200 object-contain"
            />
            <button
              type="button"
              onClick={handleRemove}
              disabled={disabled || uploading}
              className="text-sm text-red-500 hover:text-red-700 disabled:opacity-50"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
              className="text-sm text-brand hover:underline disabled:opacity-50"
            >
              Replace
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            className="rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500 hover:border-brand hover:text-brand disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '+ Add logo (PNG/JPEG, max 2 MB)'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  )
}

export default function ResumeTemplaterPage() {
  const [pageState, setPageState] = useState<PageState>('idle')
  const [resumeText, setResumeText] = useState('')
  const [profile, setProfile] = useState<ParsedProfile | null>(null)
  const [logo, setLogo] = useState<LogoInfo>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [exporting, setExporting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => stopTimer()
  }, [stopTimer])

  async function handleGenerate() {
    if (!resumeText.trim()) return

    setPageState('generating')
    setProfile(null)
    setErrorMessage(null)
    setElapsed(0)

    timerRef.current = setInterval(() => {
      setElapsed((e) => e + 1)
    }, 1000)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-parse`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ resume_text: resumeText }),
        },
      )

      const json = (await res.json()) as { profile?: ParsedProfile; error?: { message?: string } }

      if (!res.ok || !json.profile) {
        throw new Error(json.error?.message ?? 'Failed to parse resume')
      }

      stopTimer()
      setProfile(json.profile)
      setPageState('success')
    } catch (err) {
      stopTimer()
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try again.',
      )
      setPageState('error')
    }
  }

  async function handleExport() {
    if (!profile) return
    setExporting(true)

    try {
      // Fetch template DOCX
      const templateRes = await fetch('/template.docx')
      if (!templateRes.ok) throw new Error('Failed to load resume template')
      const templateBuffer = await templateRes.arrayBuffer()

      // Fetch logo bytes if configured
      let logoBytes: Uint8Array | null = null
      if (logo) {
        const logoRes = await fetch(logo.signed_url)
        if (logoRes.ok) {
          logoBytes = new Uint8Array(await logoRes.arrayBuffer())
        }
      }

      const renderData = mapParsedProfileToRenderData(profile, logoBytes)
      const blob = await exportResume(templateBuffer, renderData)

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${profile.name?.replace(/\s+/g, '_') ?? 'resume'}_fractional.docx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Export failed. Please try again.',
      )
      setPageState('error')
    } finally {
      setExporting(false)
    }
  }

  function handleRetry() {
    setPageState('idle')
    setErrorMessage(null)
    // resumeText and logo are preserved
  }

  const isGenerating = pageState === 'generating'

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <h1 className="text-lg font-bold text-brand">Fractional Portal</h1>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
        {/* Logo uploader (always visible in idle/success/error) */}
        {pageState !== 'generating' && (
          <LogoUploader logo={logo} onLogoChange={setLogo} disabled={isGenerating} />
        )}

        {/* Idle: text area + generate button */}
        {(pageState === 'idle' || pageState === 'error') && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="resume-text" className="block text-sm font-medium text-slate-700">
                Resume Text
              </label>
              <textarea
                id="resume-text"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
                placeholder="Paste resume here"
                rows={16}
                disabled={isGenerating}
                className="w-full resize-y rounded-xl border border-slate-300 p-4 text-sm leading-relaxed focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
              />
            </div>

            {pageState === 'error' && errorMessage && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <strong>Error:</strong> {errorMessage}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!resumeText.trim() || isGenerating}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-40"
              >
                Generate
              </button>
              {pageState === 'error' && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="rounded-lg border border-slate-300 px-6 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Try Again
                </button>
              )}
            </div>
          </div>
        )}

        {/* Generating: progress bar */}
        {pageState === 'generating' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <span className="text-sm font-medium text-slate-700">
                Estimated completion: {ESTIMATE_SECONDS} seconds
              </span>
            </div>
            <ProgressBar elapsed={elapsed} />
          </div>
        )}

        {/* Success: profile summary + export */}
        {pageState === 'success' && profile && (
          <div className="space-y-6">
            <ProfileSummary profile={profile} />

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-light disabled:opacity-50"
              >
                {exporting ? 'Exporting…' : 'Export .docx'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPageState('idle')
                  setProfile(null)
                }}
                className="rounded-lg border border-slate-300 px-6 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Start over
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
