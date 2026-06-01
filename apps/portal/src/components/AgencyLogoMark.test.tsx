import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LogoInfo } from '../lib/agencyLogo'

const configValue = {
  config: { identity: { name: 'Aligned Recruitment' } },
}
let logoValue: { logo: LogoInfo } = { logo: null }

vi.mock('../contexts/AgencyConfigContext', () => ({
  useAgencyConfig: () => configValue,
}))
vi.mock('../contexts/AgencyLogoContext', () => ({
  useAgencyLogo: () => logoValue,
}))

import { AgencyLogoMark } from './AgencyLogoMark'

const logo: NonNullable<LogoInfo> = {
  signed_url: 'https://example.com/logo.png',
  mime_type: 'image/png',
  width_px: 200,
  height_px: 80,
  updated_at: '2026-01-01T00:00:00Z',
}

describe('AgencyLogoMark', () => {
  it('renders the logo image when a logo is set, using the agency name as alt text', () => {
    logoValue = { logo }
    render(<AgencyLogoMark />)
    const img = screen.getByRole('img', { name: 'Aligned Recruitment' })
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png')
    expect(screen.queryByText('Aligned Recruitment')).not.toBeInTheDocument()
  })

  it('falls back to the agency name when no logo is set', () => {
    logoValue = { logo: null }
    render(<AgencyLogoMark />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('Aligned Recruitment')).toBeInTheDocument()
  })

  it('applies the provided fallback class to the name', () => {
    logoValue = { logo: null }
    render(<AgencyLogoMark fallbackClassName="custom-fallback" />)
    expect(screen.getByText('Aligned Recruitment')).toHaveClass('custom-fallback')
  })
})
