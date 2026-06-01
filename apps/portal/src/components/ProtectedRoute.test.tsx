import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'

// Mock AuthContext so tests don't need a real Supabase client
vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}))

import { useAuth } from '../contexts/AuthContext'

function TestPage() {
  return <div>Protected content</div>
}

function LoginPage() {
  return <div>Login page</div>
}

function renderWithRouter(
  initialPath: string,
  authState: { session: object | null; loading: boolean },
) {
  vi.mocked(useAuth).mockReturnValue({
    session: authState.session as ReturnType<typeof useAuth>['session'],
    user: null,
    loading: authState.loading,
  })

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/resume-templater" element={<TestPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProtectedRoute', () => {
  it('shows spinner while loading', () => {
    renderWithRouter('/resume-templater', { session: null, loading: true })
    // Spinner renders a div with animate-spin class
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })

  it('redirects to /login when unauthenticated', () => {
    renderWithRouter('/resume-templater', { session: null, loading: false })
    expect(screen.getByText('Login page')).toBeInTheDocument()
  })

  it('renders child when authenticated', () => {
    renderWithRouter('/resume-templater', {
      session: { user: { id: 'user-1' } },
      loading: false,
    })
    expect(screen.getByText('Protected content')).toBeInTheDocument()
  })
})
