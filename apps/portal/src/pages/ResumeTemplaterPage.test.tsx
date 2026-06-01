import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ParsedProfile } from '../lib/resumeTypes'
import type { FitBullet } from '../lib/submittalExport'
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
    expect(screen.getByText(/selected_experience\[0\]/)).toBeInTheDocument()
    // candidate snapshot prefers the richer fields
    expect(screen.getByText(/Work Authorization:/i)).toBeInTheDocument()
    expect(screen.getByText(/U\.S\. Citizen/i)).toBeInTheDocument()
    expect(screen.getByText(/Total Experience:/i)).toBeInTheDocument()
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
