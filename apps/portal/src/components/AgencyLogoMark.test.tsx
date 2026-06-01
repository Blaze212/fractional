import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CachedLogo } from '../lib/agencyLogo'

const configValue = {
  config: { identity: { name: 'Aligned Recruitment' } },
}
let logoValue: { logo: CachedLogo | null } = { logo: null }

vi.mock('../contexts/AgencyConfigContext', () => ({
  useAgencyConfig: () => configValue,
}))
vi.mock('../contexts/AgencyLogoContext', () => ({
  useAgencyLogo: () => logoValue,
}))

import { AgencyLogoMark } from './AgencyLogoMark'

const logo: CachedLogo = {
  url: 'blob:agency-logo',
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'image/png',
  widthPx: 200,
  heightPx: 80,
}

describe('AgencyLogoMark', () => {
  it('renders the logo image when a logo is set, using the agency name as alt text', () => {
    logoValue = { logo }
    render(<AgencyLogoMark />)
    const img = screen.getByRole('img', { name: 'Aligned Recruitment' })
    expect(img).toHaveAttribute('src', 'blob:agency-logo')
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
