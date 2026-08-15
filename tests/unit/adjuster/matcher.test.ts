import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { matchClaim } = loadGs('apps/adjuster/src/matcher.js')

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: 'claim-1',
    appt_start: '2026-08-15T13:00:00Z',
    appt_end: '2026-08-15T14:00:00Z',
    insured_last_name: 'Whitfield',
    address_line1: '412 Maple St',
    city: 'Charlotte',
    claim_number: 'C-1001',
    carrier: 'Acme',
    loss_type: 'wind',
    vendor: 'vendor-a',
    ...overrides,
  }
}

describe('matchClaim', () => {
  it('returns calendar-exact when exactly one candidate and the transcript confirms it', () => {
    const callStartedAt = '2026-08-15T14:20:00Z'
    const transcript = 'This is Brandon at 412 Maple Street for the Whitfield claim.'
    const claims = [claim()]

    const result = matchClaim(callStartedAt, transcript, claims)

    expect(result.match_method).toBe('calendar-exact')
    expect(result.match_confidence).toBe('high')
    expect(result.claim_id).toBe('claim-1')
  })

  it('returns calendar-nearest when exactly one candidate but the transcript does not confirm it', () => {
    const callStartedAt = '2026-08-15T14:20:00Z'
    const transcript = 'Roof is a 3-tab asphalt shingle, moderate wear.'
    const claims = [claim()]

    const result = matchClaim(callStartedAt, transcript, claims)

    expect(result.match_method).toBe('calendar-nearest')
    expect(result.match_confidence).toBe('low')
    expect(result.claim_id).toBe('claim-1')
  })

  it('returns ambiguous when two candidates end within 45 minutes of each other', () => {
    const callStartedAt = '2026-08-15T15:10:00Z'
    const transcript = 'Roof is a 3-tab asphalt shingle.'
    const claims = [
      claim({ claim_id: 'claim-1', appt_end: '2026-08-15T14:40:00Z' }),
      claim({ claim_id: 'claim-2', appt_end: '2026-08-15T15:00:00Z', insured_last_name: 'Ortiz' }),
    ]

    const result = matchClaim(callStartedAt, transcript, claims)

    expect(result.match_method).toBe('ambiguous')
    expect(result.match_confidence).toBe('low')
    expect(result.candidates).toHaveLength(2)
  })

  it('returns none for an empty claims list', () => {
    const result = matchClaim('2026-08-15T14:20:00Z', 'anything', [])

    expect(result).toEqual({
      claim_id: null,
      match_method: 'none',
      match_confidence: 'none',
      candidates: [],
    })
  })

  it('returns none when the call precedes every appointment', () => {
    const callStartedAt = '2026-08-15T08:00:00Z'
    const claims = [claim({ appt_end: '2026-08-15T14:00:00Z' })]

    const result = matchClaim(callStartedAt, 'anything', claims)

    expect(result.match_method).toBe('none')
    expect(result.match_confidence).toBe('none')
  })
})
