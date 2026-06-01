import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ParsedProfile } from '../lib/resumeTypes'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
      signOut: vi.fn(),
    },
  },
}))

vi.mock('../lib/resumeExport', () => ({
  mapParsedProfileToRenderData: vi.fn((profile: ParsedProfile) => ({ name: profile.name })),
  exportResume: vi.fn().mockResolvedValue(new Blob(['docx-bytes'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })),
}))

const mockProfile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: null,
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
  education: [{ institution: 'Harvard', degree: 'MBA' }],
  certifications: [],
  skills: ['Financial planning', 'M&A'],
  tools: ['NetSuite', 'Excel'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance'],
  industries: ['SaaS'],
}

function setupFetchMock(overrides: Partial<{ logoResponse: object; parseResponse: object }> = {}) {
  const logoResponse = overrides.logoResponse ?? { logo: null }
  const parseResponse = overrides.parseResponse ?? { profile: mockProfile }

  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('resume-logo')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(logoResponse),
      })
    }
    if (String(url).includes('resume-parse')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(parseResponse),
      })
    }
    // template.docx
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    })
  })
}

async function renderPage() {
  const { default: ResumeTemplaterPage } = await import('./ResumeTemplaterPage')
  return render(
    <MemoryRouter>
      <ResumeTemplaterPage />
    </MemoryRouter>,
  )
}

describe('ResumeTemplaterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupFetchMock()
  })

  it('renders textarea with placeholder and disabled Generate button', async () => {
    await renderPage()
    expect(screen.getByPlaceholderText('Paste resume here')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /generate/i })
    expect(btn).toBeDisabled()
  })

  it('enables Generate button when text area is non-empty', async () => {
    await renderPage()
    fireEvent.change(screen.getByPlaceholderText('Paste resume here'), {
      target: { value: 'Jane Smith CFO resume text' },
    })
    expect(screen.getByRole('button', { name: /generate/i })).not.toBeDisabled()
  })

  it('shows progress bar while generating', async () => {
    await renderPage()
    // Make parse hang so we can observe generating state
    setupFetchMock({
      parseResponse: undefined,
    })
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('resume-logo')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo: null }) })
      }
      // parse hangs indefinitely
      return new Promise(() => {})
    })

    fireEvent.change(screen.getByPlaceholderText('Paste resume here'), {
      target: { value: 'Some resume' },
    })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => {
      expect(screen.getByText(/estimated completion/i)).toBeInTheDocument()
    })
  })

  it('shows profile summary on success', async () => {
    setupFetchMock({ parseResponse: { profile: mockProfile } })
    await renderPage()

    fireEvent.change(screen.getByPlaceholderText('Paste resume here'), {
      target: { value: 'Jane Smith CFO resume' },
    })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => {
      expect(screen.getByText('Jane Smith')).toBeInTheDocument()
    })
    expect(screen.getByText('C-Level')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
  })

  it('shows friendly error and retry button on parse failure', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('resume-logo')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo: null }) })
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: { message: 'LLM failed' } }),
      })
    })
    await renderPage()

    fireEvent.change(screen.getByPlaceholderText('Paste resume here'), {
      target: { value: 'Jane resume' },
    })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => {
      expect(screen.getByText(/LLM failed/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('preserves pasted text after error', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('resume-logo')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo: null }) })
      }
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: { message: 'Error' } }),
      })
    })
    await renderPage()

    const textarea = screen.getByPlaceholderText('Paste resume here')
    fireEvent.change(textarea, { target: { value: 'My original resume text' } })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => screen.getByRole('button', { name: /try again/i }))

    expect((textarea as HTMLTextAreaElement).value).toBe('My original resume text')
  })

  it('shows Export button in success state', async () => {
    setupFetchMock({ parseResponse: { profile: mockProfile } })
    await renderPage()

    fireEvent.change(screen.getByPlaceholderText('Paste resume here'), {
      target: { value: 'Jane Smith CFO resume' },
    })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => screen.getByRole('button', { name: /export/i }))
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
  })
})
