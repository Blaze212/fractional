import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { ParsedProfile } from '../lib/resumeTypes'
import { mapToSubmittalRenderData, exportSubmittal } from '../lib/submittalExport'
import type { FitBullet, SubmittalFields } from '../lib/submittalExport'
import { useAgencyConfig } from '../contexts/AgencyConfigContext'
import { useAgencyLogo } from '../contexts/AgencyLogoContext'
import { AgencyLogoMark } from '../components/AgencyLogoMark'

type PageState = 'idle' | 'generating' | 'success' | 'error'
type Stage = 'parsing' | 'fit'

const ESTIMATE_SECONDS = 75

async function getToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.access_token
}

function ProgressBar({ elapsed, stage }: { elapsed: number; stage: Stage }) {
  const progress = Math.min(95, (elapsed / ESTIMATE_SECONDS) * 100)
  const label = stage === 'parsing' ? 'Reading the résumé…' : 'Writing the fit narrative…'
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm text-slate-500">
        <span>{label}</span>
        <span>
          {elapsed < ESTIMATE_SECONDS
            ? `~${Math.max(0, ESTIMATE_SECONDS - elapsed)}s remaining`
            : 'Still working…'}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className="bg-brand h-full rounded-full transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
      />
    </div>
  )
}

export default function ResumeTemplaterPage() {
  const { config } = useAgencyConfig()
  const { logo } = useAgencyLogo()
  const [pageState, setPageState] = useState<PageState>('idle')
  const [stage, setStage] = useState<Stage>('parsing')

  // Inputs
  const [clientName, setClientName] = useState('')
  const [roleTitle, setRoleTitle] = useState('')
  const [reqId, setReqId] = useState('')
  const [location, setLocation] = useState('')
  const [hiringManager, setHiringManager] = useState('')
  const [jdText, setJdText] = useState('')
  const [resumeText, setResumeText] = useState('')

  // Generated + editable
  const [profile, setProfile] = useState<ParsedProfile | null>(null)
  const [fitBullets, setFitBullets] = useState<FitBullet[]>([])
  const [fitSummary, setFitSummary] = useState('')
  const [compLogistics, setCompLogistics] = useState('')
  const [recruiterNotes, setRecruiterNotes] = useState('')

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

  const canGenerate =
    !!resumeText.trim() && !!jdText.trim() && !!clientName.trim() && !!roleTitle.trim()

  async function handleGenerate() {
    if (!canGenerate) return

    setPageState('generating')
    setStage('parsing')
    setErrorMessage(null)
    setElapsed(0)

    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)

    try {
      const token = await getToken()
      const base = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

      // Step 1 — parse résumé
      const parseRes = await fetch(`${base}/resume-parse`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume_text: resumeText }),
      })
      const parseJson = (await parseRes.json()) as {
        profile?: ParsedProfile
        error?: { message?: string }
      }
      if (!parseRes.ok || !parseJson.profile) {
        throw new Error(parseJson.error?.message ?? 'Failed to parse résumé')
      }

      // Step 2 — generate fit narrative
      setStage('fit')
      const fitRes = await fetch(`${base}/submittal-fit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parsed_profile: parseJson.profile,
          jd_text: jdText,
          client_name: clientName,
          role_title: roleTitle,
        }),
      })
      const fitJson = (await fitRes.json()) as {
        fit_bullets?: FitBullet[]
        fit_summary?: string
        error?: { message?: string }
      }
      if (!fitRes.ok || !fitJson.fit_bullets || !fitJson.fit_summary) {
        throw new Error(fitJson.error?.message ?? 'Failed to generate fit narrative')
      }

      stopTimer()
      setProfile(parseJson.profile)
      setFitBullets(fitJson.fit_bullets)
      setFitSummary(fitJson.fit_summary)
      setPageState('success')
    } catch (err) {
      stopTimer()
      setErrorMessage(
        err instanceof Error ? err.message : 'Something went wrong. Please try again.',
      )
      setPageState('error')
    }
  }

  function updateBullet(index: number, text: string) {
    setFitBullets((bullets) => bullets.map((b, i) => (i === index ? { ...b, text } : b)))
  }

  async function handleExport() {
    if (!profile) return
    setExporting(true)
    setErrorMessage(null)

    try {
      const templateRes = await fetch('/submittal-template.docx')
      if (!templateRes.ok) throw new Error('Failed to load submittal template')
      const templateBuffer = await templateRes.arrayBuffer()

      let submittalLogo: { bytes: Uint8Array; dims: { widthPx: number; heightPx: number } } | null =
        null
      if (logo?.signed_url) {
        const logoRes = await fetch(logo.signed_url)
        if (!logoRes.ok) throw new Error(`Failed to fetch logo (${logoRes.status})`)
        submittalLogo = {
          bytes: new Uint8Array(await logoRes.arrayBuffer()),
          dims: { widthPx: logo.width_px, heightPx: logo.height_px },
        }
      }

      const fields: SubmittalFields = {
        clientName,
        roleTitle,
        reqId,
        location,
        hiringManager,
        fitSummary,
        fitBullets,
        compLogistics,
        recruiterNotes,
      }
      const renderData = mapToSubmittalRenderData(profile, fields)
      const blob = exportSubmittal(templateBuffer, renderData, submittalLogo)

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const candidate = profile.name?.replace(/\s+/g, '_') ?? 'candidate'
      const client = clientName.replace(/\s+/g, '_')
      const filename = config.export.submittalFileStem
        .replace('{name}', candidate)
        .replace('{client}', client)
      a.href = url
      a.download = `${filename}.docx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Export failed. Please try again.')
      setPageState('error')
    } finally {
      setExporting(false)
    }
  }

  function backToInputs() {
    setPageState('idle')
    setErrorMessage(null)
  }

  const isGenerating = pageState === 'generating'
  const showInputs = pageState === 'idle' || pageState === 'error'

  return (
    <div className="bg-brand-muted min-h-screen">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <AgencyLogoMark />
          <nav className="flex items-center gap-4">
            <Link to="/settings" className="text-sm text-slate-500 hover:text-slate-700">
              Settings
            </Link>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
        {showInputs && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                id="client-name"
                label="Client / Company"
                value={clientName}
                onChange={setClientName}
                placeholder="e.g. Globex Corp"
                required
              />
              <TextField
                id="role-title"
                label="Role Title"
                value={roleTitle}
                onChange={setRoleTitle}
                placeholder="e.g. Chief Financial Officer"
                required
              />
              <TextField id="req-id" label="Req ID" value={reqId} onChange={setReqId} />
              <TextField
                id="location"
                label="Location"
                value={location}
                onChange={setLocation}
                placeholder="e.g. Remote (US)"
              />
              <TextField
                id="hiring-manager"
                label="Hiring Manager"
                value={hiringManager}
                onChange={setHiringManager}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="jd-text" className="block text-sm font-medium text-slate-700">
                Job Description<span className="text-red-500"> *</span>
              </label>
              <textarea
                id="jd-text"
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                placeholder="Paste the client's job description here"
                rows={8}
                className="focus:border-brand focus:ring-brand w-full resize-y rounded-xl border border-slate-300 p-4 text-sm leading-relaxed focus:outline-none focus:ring-1"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="resume-text" className="block text-sm font-medium text-slate-700">
                Candidate Résumé<span className="text-red-500"> *</span>
              </label>
              <textarea
                id="resume-text"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
                placeholder="Paste the candidate's résumé here"
                rows={12}
                className="focus:border-brand focus:ring-brand w-full resize-y rounded-xl border border-slate-300 p-4 text-sm leading-relaxed focus:outline-none focus:ring-1"
              />
            </div>

            {pageState === 'error' && errorMessage && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <strong>Error:</strong> {errorMessage}
              </div>
            )}

            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="bg-brand hover:bg-brand-light rounded-lg px-6 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pageState === 'error' ? 'Try Again' : config.ui.generateButtonLabel}
            </button>
          </div>
        )}

        {isGenerating && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="border-brand h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
              <span className="text-sm font-medium text-slate-700">
                Building submittal for {clientName}…
              </span>
            </div>
            <ProgressBar elapsed={elapsed} stage={stage} />
          </div>
        )}

        {pageState === 'success' && profile && (
          <div className="space-y-6">
            <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{profile.name ?? 'Candidate'}</h2>
                <p className="text-brand-secondary text-sm font-medium">
                  {roleTitle} @ {clientName}
                </p>
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {(profile.current_title ?? profile.selected_experience[0]?.title) && (
                  <div>
                    <dt className="inline font-medium text-slate-900">Current Title: </dt>
                    <dd className="inline text-slate-600">
                      {profile.current_title ?? profile.selected_experience[0]?.title}
                    </dd>
                  </div>
                )}
                {profile.location && (
                  <div>
                    <dt className="inline font-medium text-slate-900">Location: </dt>
                    <dd className="inline text-slate-600">{profile.location}</dd>
                  </div>
                )}
                {profile.work_authorization && (
                  <div>
                    <dt className="inline font-medium text-slate-900">Work Authorization: </dt>
                    <dd className="inline text-slate-600">{profile.work_authorization}</dd>
                  </div>
                )}
                {profile.total_experience && (
                  <div>
                    <dt className="inline font-medium text-slate-900">Total Experience: </dt>
                    <dd className="inline text-slate-600">{profile.total_experience}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="space-y-2">
              <label htmlFor="fit-summary" className="block text-sm font-semibold text-slate-800">
                Fit Summary
              </label>
              <textarea
                id="fit-summary"
                value={fitSummary}
                onChange={(e) => setFitSummary(e.target.value)}
                rows={2}
                className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-1"
              />
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-800">
                Why {profile.name ?? 'this candidate'} for {clientName}
              </h3>
              {fitBullets.map((bullet, i) => (
                <div key={i} className="space-y-1">
                  <textarea
                    aria-label={`Fit bullet ${i + 1}`}
                    value={bullet.text}
                    onChange={(e) => updateBullet(i, e.target.value)}
                    rows={2}
                    className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-1"
                  />
                  <p className="text-xs text-slate-400">Source: {bullet.source_ref}</p>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="comp-logistics"
                className="block text-sm font-semibold text-slate-800"
              >
                Compensation &amp; Logistics
              </label>
              <textarea
                id="comp-logistics"
                value={compLogistics}
                onChange={(e) => setCompLogistics(e.target.value)}
                placeholder="Target comp, availability, work authorization, location…"
                rows={3}
                className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-1"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="recruiter-notes"
                className="block text-sm font-semibold text-slate-800"
              >
                Recruiter Notes
              </label>
              <textarea
                id="recruiter-notes"
                value={recruiterNotes}
                onChange={(e) => setRecruiterNotes(e.target.value)}
                placeholder="Anything else the hiring manager should know…"
                rows={3}
                className="focus:border-brand focus:ring-brand w-full resize-y rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-1"
              />
            </div>

            {errorMessage && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <strong>Error:</strong> {errorMessage}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="bg-brand hover:bg-brand-light rounded-lg px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {exporting ? 'Exporting…' : 'Export .docx'}
              </button>
              <button
                type="button"
                onClick={backToInputs}
                className="rounded-lg border border-slate-300 px-6 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Edit inputs
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
