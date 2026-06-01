import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { ParsedProfile } from '../lib/resumeTypes'
import { mapToSubmittalRenderData, exportSubmittal } from '../lib/submittalExport'
import type { FitBullet, SubmittalFields } from '../lib/submittalExport'
import { useAgencyConfig } from '../contexts/AgencyConfigContext'
import { useAgencyLogo } from '../contexts/AgencyLogoContext'
import { AppHeader } from '../components/AppHeader'
import { AutoResizeTextarea } from '../components/AutoResizeTextarea'

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

function SectionCard({
  title,
  count,
  hint,
  children,
}: {
  title: string
  count?: number
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {typeof count === 'number' && (
          <span className="bg-brand-muted text-brand rounded-full px-2 py-0.5 text-xs font-semibold">
            {count}
          </span>
        )}
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function BulletEditor({
  index,
  label,
  value,
  sourceRef,
  onChange,
}: {
  index: number
  label: string
  value: string
  sourceRef: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex gap-3">
      <span className="bg-brand-muted text-brand mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
        {index + 1}
      </span>
      <div className="flex-1 space-y-1">
        <AutoResizeTextarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
        />
        <p className="text-right text-[11px] text-slate-400">Source: {sourceRef}</p>
      </div>
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
  const [keyQualifications, setKeyQualifications] = useState<FitBullet[]>([])
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
          fit_narrative_style_guide: config.llm.fitNarrativeStyleGuide,
        }),
      })
      const fitJson = (await fitRes.json()) as {
        fit_bullets?: FitBullet[]
        fit_summary?: string
        key_qualifications?: FitBullet[]
        error?: { message?: string }
      }
      if (!fitRes.ok || !fitJson.fit_bullets || !fitJson.fit_summary) {
        throw new Error(fitJson.error?.message ?? 'Failed to generate fit narrative')
      }

      stopTimer()
      setProfile(parseJson.profile)
      setFitBullets(fitJson.fit_bullets)
      setKeyQualifications(fitJson.key_qualifications ?? [])
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

  function updateKeyQualification(index: number, text: string) {
    setKeyQualifications((quals) => quals.map((q, i) => (i === index ? { ...q, text } : q)))
  }

  async function handleExport() {
    if (!profile) return
    setExporting(true)
    setErrorMessage(null)

    try {
      const templateRes = await fetch('/submittal-template.docx')
      if (!templateRes.ok) throw new Error('Failed to load submittal template')
      const templateBuffer = await templateRes.arrayBuffer()

      // Reuse the logo bytes cached by AgencyLogoContext — no network fetch, so
      // nothing depends on a signed URL still being valid at export time.
      const submittalLogo: {
        bytes: Uint8Array
        dims: { widthPx: number; heightPx: number }
      } | null = logo
        ? { bytes: logo.bytes, dims: { widthPx: logo.widthPx, heightPx: logo.heightPx } }
        : null

      const fields: SubmittalFields = {
        clientName,
        roleTitle,
        reqId,
        location,
        hiringManager,
        fitSummary,
        fitBullets,
        keyQualifications,
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
      <AppHeader maxWidthClass="max-w-3xl" />

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
        <h1 className="text-brand text-2xl font-bold">Resume Submittal Templater</h1>

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
              {pageState === 'error' ? 'Try Again' : 'Generate Submittal'}
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
          <div className="space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-lg font-bold text-slate-900">{profile.name ?? 'Candidate'}</h2>
                <p className="text-brand-secondary text-sm font-medium">
                  {roleTitle} @ {clientName}
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-sm sm:grid-cols-2">
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

            <SectionCard title="Fit Summary">
              <AutoResizeTextarea
                id="fit-summary"
                aria-label="Fit Summary"
                value={fitSummary}
                onChange={(e) => setFitSummary(e.target.value)}
                rows={2}
                className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
              />
            </SectionCard>

            <SectionCard
              title={`Why ${profile.name ?? 'this candidate'} for ${clientName}`}
              count={fitBullets.length}
            >
              <div className="space-y-2.5">
                {fitBullets.map((bullet, i) => (
                  <BulletEditor
                    key={i}
                    index={i}
                    label={`Fit bullet ${i + 1}`}
                    value={bullet.text}
                    sourceRef={bullet.source_ref}
                    onChange={(v) => updateBullet(i, v)}
                  />
                ))}
              </div>
            </SectionCard>

            {keyQualifications.length > 0 && (
              <SectionCard title="Key Qualifications" count={keyQualifications.length}>
                <div className="space-y-2.5">
                  {keyQualifications.map((qual, i) => (
                    <BulletEditor
                      key={i}
                      index={i}
                      label={`Key qualification ${i + 1}`}
                      value={qual.text}
                      sourceRef={qual.source_ref}
                      onChange={(v) => updateKeyQualification(i, v)}
                    />
                  ))}
                </div>
              </SectionCard>
            )}

            <SectionCard title="Compensation & Logistics" hint="One per line">
              <AutoResizeTextarea
                id="comp-logistics"
                aria-label="Compensation & Logistics"
                value={compLogistics}
                onChange={(e) => setCompLogistics(e.target.value)}
                placeholder="Target comp&#10;Availability&#10;Work authorization"
                rows={3}
                className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
              />
            </SectionCard>

            <SectionCard title="Recruiter Notes" hint="One per line">
              <AutoResizeTextarea
                id="recruiter-notes"
                aria-label="Recruiter Notes"
                value={recruiterNotes}
                onChange={(e) => setRecruiterNotes(e.target.value)}
                placeholder="Anything else the hiring manager should know…"
                rows={3}
                className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-1"
              />
            </SectionCard>

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
