import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const signOut = vi.fn()
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: () => signOut() } },
}))
vi.mock('./AgencyLogoMark', () => ({
  AgencyLogoMark: () => <span data-testid="logo-mark">logo</span>,
}))

import { AppHeader } from './AppHeader'

function renderHeader() {
  return render(
    <MemoryRouter>
      <AppHeader />
    </MemoryRouter>,
  )
}

describe('AppHeader', () => {
  it('shows the agency logo mark linking home', () => {
    renderHeader()
    expect(screen.getByTestId('logo-mark')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/resume-templater')
  })

  it('links to settings and signs out', () => {
    renderHeader()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    expect(signOut).toHaveBeenCalled()
  })
})
