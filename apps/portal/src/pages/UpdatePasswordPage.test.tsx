import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthError } from '@supabase/supabase-js'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      verifyOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
      exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi
        .fn()
        .mockResolvedValue({ data: { session: { user: { email: 'user@example.com' } } } }),
      updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
  },
}))

import UpdatePasswordPage from './UpdatePasswordPage'
import { supabase } from '../lib/supabase'

function renderWithToken() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/update-password?token_hash=abc123&type=recovery']}>
        <UpdatePasswordPage />
      </MemoryRouter>
    </StrictMode>,
  )
}

describe('UpdatePasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('verifies the recovery token exactly once under StrictMode double-invoke', async () => {
    renderWithToken()

    await waitFor(() => {
      expect(screen.getByText(/Setting password for/i)).toBeInTheDocument()
    })

    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1)
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'abc123',
      type: 'recovery',
    })
  })

  it('shows the expired message when verification fails', async () => {
    vi.mocked(supabase.auth.verifyOtp).mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new AuthError('Token has expired or is invalid', 401, 'otp_expired'),
    })
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    })

    renderWithToken()

    await waitFor(() => {
      expect(screen.getByText(/Link expired or invalid/i)).toBeInTheDocument()
    })

    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1)
  })
})
