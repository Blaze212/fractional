import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ParsedProfile } from '../lib/resumeTypes'
import type { FitBullet } from '../lib/submittalExport'
import type { FitGrade, FitAssessment } from '../lib/submittalTypes'
import { AgencyConfigProvider } from '../contexts/AgencyConfigContext'
import { AgencyLogoProvider } from '../contexts/AgencyLogoContext'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
      onAuthStateChange: vi
        .fn()
        .mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      delete: vi.fn().mockReturnThis(),
    }),
  },
}))

vi.mock('../lib/submittalExport', () => ({
  mapToSubmittalRenderData: vi.fn((profile: ParsedProfile) => ({ candidate_name: profile.name })),
  exportSubmittal: vi.fn(
    () =>
      new Blob(['docx-bytes'], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
  ),
}))

import ResumeTemplaterPage from './ResumeTemplaterPage'
import { exportSubmittal } from '../lib/submittalExport'

const mockProfile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: null,
  current_title: 'Chief Financial Officer',
  work_authorization: 'U.S. Citizen',
  total_experience: '15 years',
  summary: 'Experienced CFO in SaaS finance.',
  career_highlights: ['Led $50M Series C'],
  selected_experience: [
    {
      company: 'Acme Corp',
      title: 'CFO',
      start_date: '2019-01',
      end_date: 'Present',
      responsibilities: ['Oversaw all financial operations'],
      achievements: ['Raised $50M Series C'],
    },
  ],
  other_experience: [],
  education: [],
  certifications: [],
  skills: ['Financial planning'],
  tools: ['NetSuite'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance'],
  industries: ['SaaS'],
}

const mockBullets: FitBullet[] = [
  { text: 'Raised a $50M Series C.', source_ref: 'selected_experience[0]' },
  { text: 'Strong SaaS finance leadership.', source_ref: 'industries' },
  { text: 'Led the finance organization.', source_ref: 'career_highlights[0]' },
]

const mockKeyQualifications: FitBullet[] = [
  { text: 'Oversaw all financial operations.', source_ref: 'selected_experience[0]' },
  { text: 'Raised $50M Series C.', source_ref: 'selected_experience[0]' },
  { text: 'Reduced burn by 30%.', source_ref: 'career_highlights[1]' },
]

const mockAssessment: FitAssessment = {
  fit_level: 'moderate',
  jd_must_haves: ['SaaS CFO experience'],
  must_have_coverage: [{ requirement: 'SaaS CFO experience', met: true, evidence: 'Acme Corp' }],
  gaps: ['No public company experience', 'Limited M&A background'],
}

type FetchOverrides = {
  parseResponse?: object
  parseOk?: boolean
  fitResponse?: object
  fitOk?: boolean
}

function setupFetchMock(overrides: FetchOverrides = {}) {
  const parseResponse = overrides.parseResponse ?? { profile: mockProfile }
  const fitResponse = overrides.fitResponse ?? {
    fit_bullets: mockBullets,
    fit_summary: 'A C-Level SaaS leader.',
    key_qualifications: mockKeyQualifications,
  }

  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('resume-logo')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo: null }) })
    }
    if (String(url).includes('resume-parse')) {
      return Promise.resolve({
        ok: overrides.parseOk ?? true,
        json: () => Promise.resolve(parseResponse),
      })
    }
    if (String(url).includes('submittal-fit')) {
      return Promise.resolve({
        ok: overrides.fitOk ?? true,
        json: () => Promise.resolve(fitResponse),
      })
    }
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) })
  })
}

function renderPage() {
  return render(
    <AgencyConfigProvider>
      <AgencyLogoProvider>
        <MemoryRouter>
          <ResumeTemplaterPage />
        </MemoryRouter>
      </AgencyLogoProvider>
    </AgencyConfigProvider>,
  )
}

function fillRequiredInputs() {
  fireEvent.change(screen.getByLabelText(/Client \/ Company/i), { target: { value: 'Globex' } })
  fireEvent.change(screen.getByLabelText(/Role Title/i), { target: { value: 'CFO' } })
  fireEvent.change(screen.getByLabelText(/Job Description/i), {
    target: { value: 'We need a CFO.' },
  })
  fireEvent.change(screen.getByLabelText(/Candidate Résumé/i), {
    target: { value: 'Jane Smith CFO at Acme' },
  })
}

async function generateAndWait(grade?: FitGrade, assessment?: FitAssessment) {
  const fitResponse: Record<string, unknown> = {
    fit_bullets: mockBullets,
    fit_summary: 'A C-Level SaaS leader.',
    key_qualifications: mockKeyQualifications,
  }
  if (grade) fitResponse.grade = grade
  if (assessment) fitResponse.assessment = assessment

  setupFetchMock({ fitResponse })
  renderPage()
  fillRequiredInputs()
  fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))
  await waitFor(() => expect(screen.getByLabelText(/Fit Summary/i)).toBeInTheDocument())
}

describe('ResumeTemplaterPage (submittal)', () => {
  beforeEach(() => {
    setupFetchMock()
  })

  it('renders the page title', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Resume Submittal Templater' })).toBeInTheDocument()
  })

  it('renders the submittal inputs and disables Generate until required fields are present', () => {
    renderPage()
    const button = screen.getByRole('button', { name: /Generate Submittal/i })
    expect(button).toBeDisabled()
  })

  it('enables Generate only when client, role, JD and résumé are all present', () => {
    renderPage()
    const button = screen.getByRole('button', { name: /Generate Submittal/i })
    fireEvent.change(screen.getByLabelText(/Client \/ Company/i), { target: { value: 'Globex' } })
    fireEvent.change(screen.getByLabelText(/Role Title/i), { target: { value: 'CFO' } })
    fireEvent.change(screen.getByLabelText(/Job Description/i), { target: { value: 'JD' } })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Candidate Résumé/i), { target: { value: 'resume' } })
    expect(button).toBeEnabled()
  })

  it('calls resume-parse then submittal-fit and shows the editable result', async () => {
    renderPage()
    fillRequiredInputs()
    fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))

    await waitFor(() => expect(screen.getByLabelText(/Fit Summary/i)).toBeInTheDocument())

    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    )
    expect(calledUrls.some((u) => u.includes('resume-parse'))).toBe(true)
    expect(calledUrls.some((u) => u.includes('submittal-fit'))).toBe(true)
    expect((screen.getByLabelText(/Fit Summary/i) as HTMLTextAreaElement).value).toBe(
      'A C-Level SaaS leader.',
    )
    expect(screen.getByLabelText(/Fit bullet 1/i)).toBeInTheDocument()
    expect(screen.getAllByText(/selected_experience\[0\]/).length).toBeGreaterThan(0)
    // key qualifications selected by the LLM render as editable bullets
    expect(screen.getByLabelText(/Key qualification 1/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/Key qualification 2/i) as HTMLTextAreaElement).value).toBe(
      'Raised $50M Series C.',
    )
    // candidate snapshot prefers the richer fields
    expect(screen.getByText(/Work Authorization:/i)).toBeInTheDocument()
    expect(screen.getByText(/U\.S\. Citizen/i)).toBeInTheDocument()
    expect(screen.getByText(/Total Experience:/i)).toBeInTheDocument()
  })

  it('reads grade and assessment from the API response', async () => {
    const grade: FitGrade = {
      action: 'ship',
      failure_class: 'none',
      issues: [],
      warnings: ['Verify compensation range'],
    }
    await generateAndWait(grade, mockAssessment)

    // Banner present for ship+warnings
    expect(screen.getByText('Review before sending')).toBeInTheDocument()
    expect(screen.getByText('Verify compensation range')).toBeInTheDocument()
    // Assessment panel present
    expect(screen.getByText('Recruiter assessment')).toBeInTheDocument()
  })

  it('allows editing a fit bullet', async () => {
    renderPage()
    fillRequiredInputs()
    fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))
    await waitFor(() => expect(screen.getByLabelText(/Fit bullet 1/i)).toBeInTheDocument())

    const bullet = screen.getByLabelText(/Fit bullet 1/i) as HTMLTextAreaElement
    fireEvent.change(bullet, { target: { value: 'Edited bullet text' } })
    expect(bullet.value).toBe('Edited bullet text')
  })

  it('shows a friendly error and preserves inputs when fit generation fails', async () => {
    setupFetchMock({ fitOk: false, fitResponse: { error: { message: 'Fit failed' } } })
    renderPage()
    fillRequiredInputs()
    fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))

    await waitFor(() => expect(screen.getByText(/Fit failed/i)).toBeInTheDocument())
    expect((screen.getByLabelText(/Client \/ Company/i) as HTMLInputElement).value).toBe('Globex')
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument()
  })

  it('exports the submittal via exportSubmittal', async () => {
    renderPage()
    fillRequiredInputs()
    fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))
    await waitFor(() => expect(screen.getByLabelText(/Fit Summary/i)).toBeInTheDocument())

    const createUrl = vi.fn(() => 'blob:mock')
    const revokeUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true })
    HTMLAnchorElement.prototype.click = vi.fn()

    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    await waitFor(() => expect(exportSubmittal).toHaveBeenCalled())
  })

  it('embeds the cached logo bytes on export without re-fetching it', async () => {
    const logo = {
      signed_url: 'https://storage.example/logo.png?token=once',
      mime_type: 'image/png',
      width_px: 200,
      height_px: 80,
      updated_at: '2026-01-01T00:00:00Z',
    }
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('resume-logo')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo }) })
      }
      if (u.includes('resume-parse')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ profile: mockProfile }) })
      }
      if (u.includes('submittal-fit')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ fit_bullets: mockBullets, fit_summary: 'Summary.' }),
        })
      }
      // submittal template (arrayBuffer) + the one-time logo bytes download (blob)
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        blob: () =>
          Promise.resolve({ arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) }),
      })
    })

    renderPage()
    // Wait for the cached logo to load into the header before exporting.
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /Aligned Recruitment/i })).toBeInTheDocument(),
    )
    fillRequiredInputs()
    fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))
    await waitFor(() => expect(screen.getByLabelText(/Fit Summary/i)).toBeInTheDocument())

    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    HTMLAnchorElement.prototype.click = vi.fn()

    const logoFetchesBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('resume-logo'),
    ).length

    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    await waitFor(() => expect(exportSubmittal).toHaveBeenCalled())

    // Export reuses the cached bytes — it does not re-hit the logo endpoint.
    const logoFetchesAfter = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('resume-logo'),
    ).length
    expect(logoFetchesAfter).toBe(logoFetchesBefore)

    const calls = (exportSubmittal as ReturnType<typeof vi.fn>).mock.calls
    const logoArg = calls[calls.length - 1][2]
    expect(logoArg).not.toBeNull()
    expect(logoArg.dims).toEqual({ widthPx: 200, heightPx: 80 })
  })
})

describe('GradeBanner', () => {
  it('renders nothing when grade is null', async () => {
    await generateAndWait()
    // No banner text
    expect(screen.queryByText('Review before sending')).not.toBeInTheDocument()
    expect(
      screen.queryByText('This submittal was flagged for human review'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Content could not be verified')).not.toBeInTheDocument()
  })

  it('renders nothing when action=ship with no warnings', async () => {
    const grade: FitGrade = { action: 'ship', failure_class: 'none', issues: [], warnings: [] }
    await generateAndWait(grade)
    expect(screen.queryByText('Review before sending')).not.toBeInTheDocument()
  })

  it('renders amber warning banner when action=ship with warnings', async () => {
    const grade: FitGrade = {
      action: 'ship',
      failure_class: 'none',
      issues: [],
      warnings: ['Check salary expectations', 'Confirm visa status'],
    }
    await generateAndWait(grade)
    expect(screen.getByText('Review before sending')).toBeInTheDocument()
    expect(screen.getByText('Check salary expectations')).toBeInTheDocument()
    expect(screen.getByText('Confirm visa status')).toBeInTheDocument()
  })

  it('renders orange banner for human_review + structural', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'structural',
      issues: ['Missing work history section'],
      warnings: [],
    }
    await generateAndWait(grade)
    expect(screen.getByText('This submittal was flagged for human review')).toBeInTheDocument()
    expect(screen.getByText('Missing work history section')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Regenerate/i })).not.toBeInTheDocument()
  })

  it('renders red banner with Regenerate button for human_review + hallucination', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'hallucination',
      issues: ['Unverifiable claim detected'],
      warnings: [],
    }
    await generateAndWait(grade)
    expect(screen.getByText('Content could not be verified')).toBeInTheDocument()
    expect(screen.getByText('Unverifiable claim detected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeInTheDocument()
  })

  it('caps displayed issues at 3 and shows overflow count', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'structural',
      issues: ['Issue 1', 'Issue 2', 'Issue 3', 'Issue 4', 'Issue 5'],
      warnings: [],
    }
    await generateAndWait(grade)
    expect(screen.getByText('Issue 1')).toBeInTheDocument()
    expect(screen.getByText('Issue 2')).toBeInTheDocument()
    expect(screen.getByText('Issue 3')).toBeInTheDocument()
    expect(screen.queryByText('Issue 4')).not.toBeInTheDocument()
    expect(screen.getByText('…and 2 more')).toBeInTheDocument()
  })

  it('caps displayed warnings at 3 and shows overflow count', async () => {
    const grade: FitGrade = {
      action: 'ship',
      failure_class: 'none',
      issues: [],
      warnings: ['W1', 'W2', 'W3', 'W4'],
    }
    await generateAndWait(grade)
    expect(screen.getByText('W1')).toBeInTheDocument()
    expect(screen.getByText('W3')).toBeInTheDocument()
    expect(screen.queryByText('W4')).not.toBeInTheDocument()
    expect(screen.getByText('…and 1 more')).toBeInTheDocument()
  })

  it('Regenerate button re-fires the generate flow', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'hallucination',
      issues: [],
      warnings: [],
    }
    await generateAndWait(grade)

    const fetchCallsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }))
    await waitFor(() => {
      const fetchCallsAfter = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length
      expect(fetchCallsAfter).toBeGreaterThan(fetchCallsBefore)
    })
  })
})

describe('Section visibility labels', () => {
  it('hides "Internal only" section for a clean ship with no assessment', async () => {
    await generateAndWait()
    expect(screen.queryByText('Internal only')).not.toBeInTheDocument()
  })

  it('shows "Internal only" section when grade has warnings', async () => {
    const grade: FitGrade = {
      action: 'ship',
      failure_class: 'none',
      issues: [],
      warnings: ['Check salary expectations'],
    }
    await generateAndWait(grade)
    expect(screen.getByText('Internal only')).toBeInTheDocument()
  })

  it('shows "Internal only" section when assessment is present', async () => {
    await generateAndWait(undefined, mockAssessment)
    expect(screen.getByText('Internal only')).toBeInTheDocument()
  })

  it('always shows "Included in export" divider after generation', async () => {
    await generateAndWait()
    expect(screen.getByText('Included in export')).toBeInTheDocument()
  })
})

describe('RecruiterAssessment', () => {
  it('renders nothing when assessment is null', async () => {
    await generateAndWait()
    expect(screen.queryByText('Recruiter assessment')).not.toBeInTheDocument()
  })

  it('renders the assessment panel with fit_level badge', async () => {
    await generateAndWait(undefined, mockAssessment)
    expect(screen.getByText('Recruiter assessment')).toBeInTheDocument()
    expect(screen.getByText(/moderate/i)).toBeInTheDocument()
  })

  it('is open by default when fit_level is not strong', async () => {
    await generateAndWait(undefined, { ...mockAssessment, fit_level: 'weak' })
    // Panel open — gaps are visible, "no gaps" message is absent
    expect(screen.queryByText('No gaps identified.')).not.toBeInTheDocument()
    expect(screen.getByText('No public company experience')).toBeInTheDocument()
  })

  it('is closed by default when fit_level is strong', async () => {
    await generateAndWait(undefined, {
      ...mockAssessment,
      fit_level: 'strong',
      gaps: ['Minor gap'],
    })
    // Panel closed — gaps not visible
    expect(screen.queryByText('Minor gap')).not.toBeInTheDocument()
  })

  it('toggles open/closed when header is clicked', async () => {
    await generateAndWait(undefined, { ...mockAssessment, fit_level: 'strong', gaps: ['A gap'] })
    expect(screen.queryByText('A gap')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Recruiter assessment/i }))
    expect(screen.getByText('A gap')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Recruiter assessment/i }))
    expect(screen.queryByText('A gap')).not.toBeInTheDocument()
  })

  it('shows "No gaps identified." when gaps array is empty and panel is open', async () => {
    await generateAndWait(undefined, { ...mockAssessment, fit_level: 'weak', gaps: [] })
    expect(screen.getByText('No gaps identified.')).toBeInTheDocument()
  })

  it('renders correct badge colour classes for each fit_level', async () => {
    const levels: FitAssessment['fit_level'][] = ['strong', 'moderate', 'weak', 'not_recommended']
    const expectedText = ['strong', 'moderate', 'weak', 'not recommended']

    for (let i = 0; i < levels.length; i++) {
      const { unmount } = renderPage()
      setupFetchMock({
        fitResponse: {
          fit_bullets: mockBullets,
          fit_summary: 'Summary.',
          assessment: { ...mockAssessment, fit_level: levels[i] },
        },
      })
      fillRequiredInputs()
      fireEvent.click(screen.getByRole('button', { name: /Generate Submittal/i }))
      await waitFor(() => expect(screen.getByText('Recruiter assessment')).toBeInTheDocument())
      expect(screen.getByText(expectedText[i])).toBeInTheDocument()
      unmount()
      vi.clearAllMocks()
      setupFetchMock()
    }
  })
})

describe('Export gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupFetchMock()
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    HTMLAnchorElement.prototype.click = vi.fn()
  })

  it('exports directly when grade is null (no confirmation)', async () => {
    await generateAndWait()
    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    await waitFor(() => expect(exportSubmittal).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('exports directly when action=ship (no confirmation)', async () => {
    const grade: FitGrade = { action: 'ship', failure_class: 'none', issues: [], warnings: [] }
    await generateAndWait(grade)
    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    await waitFor(() => expect(exportSubmittal).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows confirmation dialog when action=human_review', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'structural',
      issues: [],
      warnings: [],
    }
    await generateAndWait(grade)
    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Export flagged submittal?')).toBeInTheDocument()
    expect(exportSubmittal).not.toHaveBeenCalled()
  })

  it('"Export anyway" proceeds with export and closes dialog', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'structural',
      issues: [],
      warnings: [],
    }
    await generateAndWait(grade)
    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    fireEvent.click(screen.getByRole('button', { name: /Export anyway/i }))
    await waitFor(() => expect(exportSubmittal).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Cancel" closes dialog without exporting', async () => {
    const grade: FitGrade = {
      action: 'human_review',
      failure_class: 'hallucination',
      issues: [],
      warnings: [],
    }
    await generateAndWait(grade)
    fireEvent.click(screen.getByRole('button', { name: /Export \.docx/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(exportSubmittal).not.toHaveBeenCalled()
  })
})
