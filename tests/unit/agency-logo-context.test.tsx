import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

import { AgencyLogoProvider, useAgencyLogo } from '../../apps/portal/src/contexts/AgencyLogoContext'
import type { CachedLogo } from '../../apps/portal/src/lib/agencyLogo'

type AuthCb = (event: string, session: { user: { id: string } } | null) => void
const authCallbacks: AuthCb[] = []
const loadAgencyLogo = vi.fn()

vi.mock('../../apps/portal/src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        authCallbacks.push(cb)
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
    },
  },
}))

vi.mock('../../apps/portal/src/lib/agencyLogo', () => ({
  loadAgencyLogo: () => loadAgencyLogo(),
}))

const SESSION = { user: { id: 'u1' } }
const LOGO: CachedLogo = {
  url: 'blob:agency-logo',
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'image/png',
  widthPx: 200,
  heightPx: 80,
}

function LogoProbe() {
  const { logo } = useAgencyLogo()
  return <span data-testid="logo">{logo?.url ?? 'none'}</span>
}

beforeEach(() => {
  authCallbacks.length = 0
  loadAgencyLogo.mockResolvedValue(LOGO)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AgencyLogoProvider', () => {
  it('loads and exposes the cached agency logo', async () => {
    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('blob:agency-logo'))
  })

  it('clears the logo and revokes its object URL on sign-out', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')

    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('blob:agency-logo'))

    await act(async () => {
      for (const cb of authCallbacks) cb('SIGNED_OUT', null)
    })

    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('none'))
    expect(revoke).toHaveBeenCalledWith('blob:agency-logo')
    revoke.mockRestore()
  })

  it('exposes no logo when none is set', async () => {
    loadAgencyLogo.mockResolvedValue(null)

    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('none'))
  })
})
