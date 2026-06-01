import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

import {
  AgencyConfigProvider,
  useAgencyConfig,
  applyBrandCssVars,
} from '../../apps/portal/src/contexts/AgencyConfigContext'
import { AGENCY_CONFIG } from '../../apps/portal/src/lib/agencyConfig'

// ─── Supabase mock ───────────────────────────────────────────────────────────
// Capture the auth-state callback so each test can drive INITIAL_SESSION /
// SIGNED_OUT events explicitly and assert how the provider reacts.

type AuthCb = (event: string, session: { user: { id: string } } | null) => void
const authCallbacks: AuthCb[] = []
const getSessionMock = vi.fn()
const maybeSingleMock = vi.fn()
const upsertMock = vi.fn(() => Promise.resolve({}))
const deleteEqMock = vi.fn(() => Promise.resolve({}))

vi.mock('../../apps/portal/src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        authCallbacks.push(cb)
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
      getSession: () => getSessionMock(),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }),
      upsert: upsertMock,
      delete: () => ({ eq: deleteEqMock }),
    }),
  },
}))

function emitAuth(event: string, session: { user: { id: string } } | null) {
  for (const cb of authCallbacks) cb(event, session)
}

function ConfigProbe() {
  const { config } = useAgencyConfig()
  return <span data-testid="primary">{config.brand.primary}</span>
}

function brandVar(name: string) {
  return document.documentElement.style.getPropertyValue(name).trim()
}

const CUSTOM = {
  primary: '#ff0000',
  primaryLight: '#ff6666',
  secondary: '#00aa00',
  muted: '#fff0f0',
  onPrimary: '#ffffff',
  onSecondary: '#ffffff',
}

beforeEach(() => {
  authCallbacks.length = 0
  getSessionMock.mockResolvedValue({ data: { session: null } })
  maybeSingleMock.mockResolvedValue({ data: null })
  localStorage.removeItem('agency_config')
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('applyBrandCssVars', () => {
  it('writes all four brand colors — including secondary and muted — to the root element', () => {
    applyBrandCssVars(CUSTOM)
    expect(brandVar('--color-brand')).toBe('#ff0000')
    expect(brandVar('--color-brand-light')).toBe('#ff6666')
    expect(brandVar('--color-brand-secondary')).toBe('#00aa00')
    expect(brandVar('--color-brand-muted')).toBe('#fff0f0')
  })
})

describe('AgencyConfigProvider brand application', () => {
  it('applies the cached brand colors on mount', async () => {
    localStorage.setItem('agency_config', JSON.stringify({ brand: CUSTOM }))

    render(
      <AgencyConfigProvider>
        <ConfigProbe />
      </AgencyConfigProvider>,
    )

    await waitFor(() => expect(brandVar('--color-brand')).toBe('#ff0000'))
    expect(brandVar('--color-brand-secondary')).toBe('#00aa00')
    expect(brandVar('--color-brand-muted')).toBe('#fff0f0')
    expect(screen.getByTestId('primary')).toHaveTextContent('#ff0000')
  })

  it('keeps the cached brand on INITIAL_SESSION with no user (e.g. public /login pages)', async () => {
    localStorage.setItem('agency_config', JSON.stringify({ brand: CUSTOM }))

    render(
      <AgencyConfigProvider>
        <ConfigProbe />
      </AgencyConfigProvider>,
    )

    await act(async () => {
      emitAuth('INITIAL_SESSION', null)
    })

    // The cache must survive and the brand must stay applied — this is the bug:
    // the no-session branch used to wipe localStorage and reset to defaults.
    expect(localStorage.getItem('agency_config')).not.toBeNull()
    expect(brandVar('--color-brand')).toBe('#ff0000')
    expect(screen.getByTestId('primary')).toHaveTextContent('#ff0000')
  })

  it('resets to defaults and clears the cache only on an explicit SIGNED_OUT', async () => {
    localStorage.setItem('agency_config', JSON.stringify({ brand: CUSTOM }))

    render(
      <AgencyConfigProvider>
        <ConfigProbe />
      </AgencyConfigProvider>,
    )

    await waitFor(() => expect(brandVar('--color-brand')).toBe('#ff0000'))

    await act(async () => {
      emitAuth('SIGNED_OUT', null)
    })

    await waitFor(() => expect(brandVar('--color-brand')).toBe(AGENCY_CONFIG.brand.primary))
    expect(localStorage.getItem('agency_config')).toBeNull()
    expect(screen.getByTestId('primary')).toHaveTextContent(AGENCY_CONFIG.brand.primary)
  })

  it('applies the brand fetched from the database for a signed-in user', async () => {
    maybeSingleMock.mockResolvedValue({ data: { config: { brand: CUSTOM } } })

    render(
      <AgencyConfigProvider>
        <ConfigProbe />
      </AgencyConfigProvider>,
    )

    await act(async () => {
      emitAuth('INITIAL_SESSION', { user: { id: 'user-1' } })
    })

    await waitFor(() => expect(brandVar('--color-brand')).toBe('#ff0000'))
    expect(brandVar('--color-brand-secondary')).toBe('#00aa00')
    expect(brandVar('--color-brand-muted')).toBe('#fff0f0')
    expect(localStorage.getItem('agency_config')).not.toBeNull()
  })
})
