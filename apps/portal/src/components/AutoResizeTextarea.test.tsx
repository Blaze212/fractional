import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { AutoResizeTextarea } from './AutoResizeTextarea'

// jsdom reports scrollHeight as 0, so simulate content-driven height: taller
// for longer text. This lets us verify the textarea resizes to fit its value.
let scrollSpy: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  scrollSpy = vi
    .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
    .mockImplementation(function (this: HTMLTextAreaElement) {
      return 20 + this.value.length * 5
    })
})

afterAll(() => {
  scrollSpy.mockRestore()
})

describe('AutoResizeTextarea', () => {
  it('sets its height to fit the initial value', () => {
    render(<AutoResizeTextarea aria-label="box" value={'a'.repeat(10)} onChange={() => {}} />)
    const el = screen.getByLabelText('box') as HTMLTextAreaElement
    expect(el.style.height).toBe(`${20 + 10 * 5}px`)
  })

  it('grows as more text is entered', () => {
    function Harness() {
      const [v, setV] = useState('short')
      return (
        <AutoResizeTextarea aria-label="box" value={v} onChange={(e) => setV(e.target.value)} />
      )
    }
    render(<Harness />)
    const el = screen.getByLabelText('box') as HTMLTextAreaElement
    const initial = parseInt(el.style.height, 10)

    fireEvent.change(el, { target: { value: 'a much longer piece of text than before' } })
    const grown = parseInt(el.style.height, 10)

    expect(grown).toBeGreaterThan(initial)
  })

  it('disables manual resize and hides overflow', () => {
    render(<AutoResizeTextarea aria-label="box" value="x" onChange={() => {}} className="p-3" />)
    const el = screen.getByLabelText('box')
    expect(el).toHaveClass('resize-none', 'overflow-hidden', 'p-3')
  })
})
