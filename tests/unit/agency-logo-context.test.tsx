import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

import { AgencyLogoProvider, useAgencyLogo } from '../../apps/portal/src/contexts/AgencyLogoContext'
import type { LogoInfo } from '../../apps/portal/src/lib/agencyLogo'

type AuthCb = (
  event: string,
  session: { access_token: string; user: { id: string } } | null,
) => void
const authCallbacks: AuthCb[] = []
const getSessionMock = vi.fn()

vi.mock('../../apps/portal/src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        authCallbacks.push(cb)
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
      getSession: () => getSessionMock(),
    },
  },
}))

const SESSION = { access_token: 'tok', user: { id: 'u1' } }
const LOGO: NonNullable<LogoInfo> = {
  signed_url: 'https://example.com/logo.png',
  mime_type: 'image/png',
  width_px: 200,
  height_px: 80,
  updated_at: '2026-01-01T00:00:00Z',
}

function LogoProbe() {
  const { logo } = useAgencyLogo()
  return <span data-testid="logo">{logo?.signed_url ?? 'none'}</span>
}

function fetchReturning(logo: LogoInfo) {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ logo }) })
}

beforeEach(() => {
  authCallbacks.length = 0
  getSessionMock.mockResolvedValue({ data: { session: SESSION } })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AgencyLogoProvider', () => {
  it('fetches and exposes the agency logo for a signed-in user', async () => {
    global.fetch = fetchReturning(LOGO)

    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('logo')).toHaveTextContent('https://example.com/logo.png'),
    )
  })

  it('exposes no logo when there is no session and never calls the logo endpoint', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    global.fetch = fetchReturning(LOGO)

    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('none'))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('clears the logo on sign-out', async () => {
    global.fetch = fetchReturning(LOGO)

    render(
      <AgencyLogoProvider>
        <LogoProbe />
      </AgencyLogoProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('logo')).toHaveTextContent('https://example.com/logo.png'),
    )

    await act(async () => {
      for (const cb of authCallbacks) cb('SIGNED_OUT', null)
    })

    await waitFor(() => expect(screen.getByTestId('logo')).toHaveTextContent('none'))
  })
})
