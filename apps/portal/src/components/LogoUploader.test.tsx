import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { LogoInfo } from '../lib/agencyLogo'

const setLogo = vi.fn()
const refreshLogo = vi.fn()
let logoValue: LogoInfo = null

vi.mock('../contexts/AgencyLogoContext', () => ({
  useAgencyLogo: () => ({ logo: logoValue, setLogo, refreshLogo, loading: false }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
  },
}))

import { LogoUploader } from './LogoUploader'

const logo: NonNullable<LogoInfo> = {
  signed_url: 'https://example.com/logo.png',
  mime_type: 'image/png',
  width_px: 200,
  height_px: 80,
  updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  logoValue = null
  setLogo.mockClear()
  refreshLogo.mockClear()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
})

describe('LogoUploader', () => {
  it('shows the add-logo prompt when no logo is set', () => {
    render(<LogoUploader />)
    expect(screen.getByRole('button', { name: /Add logo/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument()
  })

  it('shows the current logo with Remove and Replace actions when a logo is set', () => {
    logoValue = logo
    render(<LogoUploader />)
    expect(screen.getByRole('img', { name: /Agency logo/i })).toHaveAttribute(
      'src',
      logo.signed_url,
    )
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Replace/i })).toBeInTheDocument()
  })

  it('deletes the logo and clears it on Remove', async () => {
    logoValue = logo
    render(<LogoUploader />)

    fireEvent.click(screen.getByRole('button', { name: /Remove/i }))

    await waitFor(() => expect(setLogo).toHaveBeenCalledWith(null))
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toContain('resume-logo')
    expect(init.method).toBe('DELETE')
  })

  it('disables the actions when disabled', () => {
    logoValue = logo
    render(<LogoUploader disabled />)
    expect(screen.getByRole('button', { name: /Remove/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Replace/i })).toBeDisabled()
  })
})
