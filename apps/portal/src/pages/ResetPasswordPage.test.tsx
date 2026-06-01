import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
  },
}))

import ResetPasswordPage from './ResetPasswordPage'

function renderResetPage() {
  return render(
    <MemoryRouter>
      <ResetPasswordPage />
    </MemoryRouter>,
  )
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders email field and submit button', () => {
    renderResetPage()
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument()
  })

  it('shows enumeration-safe confirmation regardless of account existence', async () => {
    renderResetPage()
    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'anyone@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() => {
      expect(
        screen.getByText(/if an account exists/i),
      ).toBeInTheDocument()
    })
  })

  it('shows same confirmation for a non-existent email', async () => {
    renderResetPage()
    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'nobody@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() => {
      expect(screen.getByText(/if an account exists/i)).toBeInTheDocument()
    })
  })

  it('passes the correct redirectTo to resetPasswordForEmail', async () => {
    const { supabase } = await import('../lib/supabase')
    renderResetPage()
    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }))

    await waitFor(() => {
      expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ redirectTo: expect.stringContaining('/update-password') }),
      )
    })
  })
})
