import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'tests/unit/adjuster/fixtures', name), 'utf-8'),
  )
}

// Spec 023's red baseline. c1 and c2 are two real calls (both
// openai/gpt-5.6-luna) whose extracted field values are factually correct but
// grammatically broken prose — see the spec's "Observed defects" section for
// the full write-up. These fixtures pin the raw extracted values so the fix
// (prompt.js Phases 1-3, docgen.js Phases 4-5) is measured against real
// defects rather than a synthetic example, and this file only asserts on the
// raw values themselves — never on how the pipeline renders or lints them —
// so it stays a stable record of what the model produced regardless of how
// later phases change the pipeline's handling of it.
describe('c1/c2 prose defects (red baseline)', () => {
  const c1 = loadFixture('c1-extraction.json')
  const c2 = loadFixture('c2-extraction.json')

  it('c1 left_elevation_status opens with a denial and then contradicts it', () => {
    const value = c1.fields.left_elevation_status.value

    expect(value).toMatch(/^We observed no storm-related damages/)
    expect(value).toMatch(/blown, wind damaged and missing/)
  })

  it('c1 origin_narrative renders "due to a storm passed through", duplicating the date merge field', () => {
    const clause = c1.fields.origin_narrative.value
    const rendered =
      'Damage occurred due to ' + clause + ' on [DATE_LOSS], resulting in damage to X.'

    expect(clause).toBe('a storm passed through the area on the day of loss')
    expect(rendered).toContain('due to a storm passed through')
    expect(rendered).toMatch(/on the day of loss on \[DATE_LOSS\]/)
  })

  it('c1 subrogation_reason destroys its template sentence', () => {
    const clause = c1.fields.subrogation_reason.value
    const rendered = 'There are no subrogation possibilities as the damages are ' + clause + '.'

    expect(clause).toBe('no subrogation concerns were reported')
    expect(rendered).toBe(
      'There are no subrogation possibilities as the damages are no subrogation concerns were reported.',
    )
  })

  it('c1 roof_covering_type spells out a number beside a digit in the same rendered sentence', () => {
    const rendered =
      'The shingles on the roof are a ' +
      c1.fields.roof_covering_type.value +
      ' that are approximately ' +
      c1.fields.roof_age_years.value +
      ' years old.'

    expect(rendered).toBe(
      'The shingles on the roof are a thirty-year laminate that are approximately 23 years old.',
    )
  })

  it('c1 dwelling_stories and dwelling_type fight their own template', () => {
    const rendered =
      'The dwelling is a ' +
      c1.fields.dwelling_stories.value +
      ', ' +
      c1.fields.dwelling_type.value +
      ' structure.'

    expect(rendered).toBe('The dwelling is a 1, single-family home structure.')
  })

  it('c1 and c2 overhead_profit_narrative drop the required claim-specific reason', () => {
    expect(c1.fields.overhead_profit_narrative.value).toBe('Overhead and profit do not apply.')
    expect(c2.fields.overhead_profit_narrative.value).toBe(
      'No overhead and profit considerations.',
    )
  })

  it('c2 front_elevation_status says "two" twice and spells out both measurements', () => {
    const value = c2.fields.front_elevation_status.value

    expect(value).toMatch(/^We observed two large glass panels/)
    expect(value).toMatch(/there are two of them/)
    expect(value).toMatch(/sixty-six inches by sixty inches/)
  })

  it('c2 sets interior_status not_affected while still filling interior_damage_narrative', () => {
    expect(c2.fields.interior_status.value).toBe('not_affected')
    expect(c2.fields.interior_damage_narrative.value).toContain('Main Lobby:')
  })
})
