import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { ParsedProfile } from '../lib/resumeTypes'
import { mapToSubmittalRenderData, exportSubmittal } from '../lib/submittalExport'
import type { FitBullet, SubmittalFields } from '../lib/submittalExport'
import type { FitGrade, FitAssessment } from '../lib/submittalTypes'
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

function GradeBanner({
  grade,
  onRegenerate,
  isGenerating,
}: {
  grade: FitGrade | null
  onRegenerate: () => void
  isGenerating: boolean
}) {
  if (!grade) return null
  if (grade.action === 'ship' && grade.warnings.length === 0) return null

  const MAX_VISIBLE = 3

  if (grade.action === 'ship') {
    const visible = grade.warnings.slice(0, MAX_VISIBLE)
    const overflow = grade.warnings.length - MAX_VISIBLE
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
        <p className="text-sm font-semibold">Review before sending</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {visible.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        {overflow > 0 && <p className="mt-1 pl-5 text-xs opacity-70">…and {overflow} more</p>}
      </div>
    )
  }

  const visibleIssues = grade.issues.slice(0, MAX_VISIBLE)
  const issueOverflow = grade.issues.length - MAX_VISIBLE

  if (grade.action === 'human_review' && grade.failure_class === 'hallucination') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
        <p className="text-sm font-semibold">Content could not be verified</p>
        {grade.issues.length > 0 && (
          <>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {visibleIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
            {issueOverflow > 0 && (
              <p className="mt-1 pl-5 text-xs opacity-70">…and {issueOverflow} more</p>
            )}
          </>
        )}
        <button
          type="button"
          onClick={onRegenerate}
          disabled={isGenerating}
          className="mt-3 rounded border border-red-300 px-3 py-1 text-xs font-semibold text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Regenerate
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-orange-800">
      <p className="text-sm font-semibold">This submittal was flagged for human review</p>
      {grade.issues.length > 0 && (
        <>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {visibleIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
          {issueOverflow > 0 && (
            <p className="mt-1 pl-5 text-xs opacity-70">…and {issueOverflow} more</p>
          )}
        </>
      )}
    </div>
  )
}

const FIT_LEVEL_CLASSES: Record<FitAssessment['fit_level'], string> = {
  strong: 'bg-green-100 text-green-800',
  moderate: 'bg-amber-100 text-amber-800',
  weak: 'bg-orange-100 text-orange-800',
  not_recommended: 'bg-red-100 text-red-800',
}

function RecruiterAssessment({ assessment }: { assessment: FitAssessment | null }) {
  const defaultOpen = assessment !== null && assessment.fit_level !== 'strong'
  const [open, setOpen] = useState(defaultOpen)

  if (!assessment) return null

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3"
        aria-expanded={open}
      >
        <span className="text-cs-muted text-sm font-semibold">Recruiter assessment</span>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${FIT_LEVEL_CLASSES[assessment.fit_level]}`}
          >
            {assessment.fit_level.replace('_', ' ')}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {assessment.gaps.length === 0 ? (
            <p className="text-cs-text text-sm">No gaps identified.</p>
          ) : (
            <ul className="space-y-1">
              {assessment.gaps.map((gap, i) => (
                <li key={i} className="text-cs-text flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                  {gap}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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

  // Grade + assessment
  const [fitGrade, setFitGrade] = useState<FitGrade | null>(null)
  const [fitAssessment, setFitAssessment] = useState<FitAssessment | null>(null)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [confirmExportOpen, setConfirmExportOpen] = useState(false)
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
    setFitGrade(null)
    setFitAssessment(null)

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
        grade?: FitGrade
        assessment?: FitAssessment
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
      setFitGrade(fitJson.grade ?? null)
      setFitAssessment(fitJson.assessment ?? null)
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

  function handleExportClick() {
    if (fitGrade?.action === 'human_review') {
      setConfirmExportOpen(true)
    } else {
      void doExport()
    }
  }

  async function doExport() {
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

            {(fitAssessment !== null ||
              (fitGrade !== null &&
                (fitGrade.action !== 'ship' || fitGrade.warnings.length > 0))) && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                    Internal only
                  </span>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>
                <GradeBanner
                  grade={fitGrade}
                  onRegenerate={handleGenerate}
                  isGenerating={isGenerating}
                />
                <RecruiterAssessment assessment={fitAssessment} />
              </div>
            )}

            <div className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Included in export
              </span>
              <div className="h-px flex-1 bg-slate-200" />
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
                onClick={handleExportClick}
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

        {confirmExportOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-export-title"
          >
            <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
              <h2 id="confirm-export-title" className="text-base font-semibold text-slate-900">
                Export flagged submittal?
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                This submittal was flagged for human review. The recruiter should verify the content
                before sending to a hiring manager.
              </p>
              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmExportOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmExportOpen(false)
                    void doExport()
                  }}
                  className="bg-brand hover:bg-brand-light rounded-lg px-4 py-2 text-sm font-semibold text-white"
                >
                  Export anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
