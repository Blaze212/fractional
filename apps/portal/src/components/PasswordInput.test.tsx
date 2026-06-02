import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PasswordInput } from './PasswordInput'

describe('PasswordInput', () => {
  it('starts masked with a "Show password" toggle and no emoji', () => {
    render(<PasswordInput placeholder="Password" />)

    const input = screen.getByPlaceholderText('Password')
    expect(input).toHaveAttribute('type', 'password')

    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(toggle.textContent).toBe('')
    expect(toggle.querySelector('svg')).toBeInTheDocument()
  })

  it('toggles visibility and the aria-label when clicked', () => {
    render(<PasswordInput placeholder="Password" />)

    const input = screen.getByPlaceholderText('Password')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(input).toHaveAttribute('type', 'password')
  })
})
