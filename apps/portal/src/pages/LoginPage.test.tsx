import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
    },
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) }
})

import LoginPage from './LoginPage'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

function renderLogin() {
  vi.mocked(useAuth).mockReturnValue({ session: null, user: null, loading: false })
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders email, password, and submit button', () => {
    renderLogin()
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('shows generic error on failed login — no enumeration info', async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
      data: { user: null, session: null },
      error: {
        message: 'Invalid login credentials',
        status: 400,
        name: 'AuthApiError',
        code: 'invalid_credentials',
      },
    } as ReturnType<typeof supabase.auth.signInWithPassword> extends Promise<infer R> ? R : never)

    renderLogin()

    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'wrongpassword' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password.')).toBeInTheDocument()
    })

    // Must NOT expose the raw Supabase error message
    expect(screen.queryByText('Invalid login credentials')).not.toBeInTheDocument()
  })

  it('does not show sign-up link', () => {
    renderLogin()
    expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/create account/i)).not.toBeInTheDocument()
  })

  it('shows forgot password link', () => {
    renderLogin()
    expect(screen.getByText('Forgot password?')).toBeInTheDocument()
  })
})
