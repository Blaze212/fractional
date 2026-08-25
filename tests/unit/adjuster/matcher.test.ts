import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { matchClaim } = loadGs('apps/adjuster/src/matcher.js')

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: 'claim-1',
    appt_start: '2026-08-19T13:00:00Z',
    appt_end: '2026-08-19T14:00:00Z',
    insured_last_name: 'Holdridge',
    address_line1: '10503 Waters Drive',
    city: 'Irving',
    claim_number: 'CLM 112233',
    carrier: 'State Farm',
    loss_type: 'Fire',
    vendor: 'Johnny',
    ...overrides,
  }
}

const NEXT_DAY = '2026-08-20T16:00:00Z'

describe('matching is not gated on the call time', () => {
  it('matches a note dictated the next morning', () => {
    const transcript = 'This is the Holdridge file at 10503 Waters Drive in Irving.'

    const result = matchClaim(NEXT_DAY, transcript, [claim()])

    expect(result.claim_id).toBe('claim-1')
    expect(result.match_confidence).toBe('high')
  })

  it('matches a note dictated a week later', () => {
    const result = matchClaim('2026-08-26T20:00:00Z', 'Holdridge, 10503 Waters Drive.', [claim()])

    expect(result.claim_id).toBe('claim-1')
  })

  it('matches when the claim has no appointment times at all', () => {
    const result = matchClaim(NEXT_DAY, 'Holdridge at 10503 Waters Drive.', [
      claim({ appt_start: '', appt_end: '' }),
    ])

    expect(result.claim_id).toBe('claim-1')
    expect(result.match_confidence).toBe('high')
  })
})

describe('claim number is the strongest signal', () => {
  it('matches a claim number read out with separators', () => {
    const result = matchClaim(NEXT_DAY, 'Claim number is C-L-M 112233, State Farm file.', [claim()])

    expect(result.match_method).toBe('claim-number')
    expect(result.match_confidence).toBe('high')
  })

  it('matches a claim number read out as spoken digits', () => {
    const transcript = 'Claim number C L M one one two two three three.'

    const result = matchClaim(NEXT_DAY, transcript, [claim()])

    expect(result.match_method).toBe('claim-number')
    expect(result.match_confidence).toBe('high')
  })

  it('outranks a different claim sitting closer in time', () => {
    const spoken = claim({ claim_id: 'spoken', appt_end: '' })
    const nearby = claim({
      claim_id: 'nearby',
      claim_number: 'CLM 999999',
      insured_last_name: 'Nguyen',
      address_line1: '77 Elm Court',
      city: 'Plano',
      appt_end: NEXT_DAY,
    })

    const result = matchClaim(NEXT_DAY, 'Claim number CLM 112233.', [nearby, spoken])

    expect(result.claim_id).toBe('spoken')
  })
})

describe('time is a weight, not a gate', () => {
  it('does not match on time proximity alone when the transcript names nobody', () => {
    const result = matchClaim('2026-08-19T14:10:00Z', 'Roof is a 3-tab asphalt shingle.', [
      claim({ claim_number: '', insured_last_name: '', address_line1: '', city: '' }),
    ])

    expect(result.claim_id).toBeNull()
    expect(result.match_method).toBe('none')
  })

  it('breaks a tie between two equally named claims using proximity', () => {
    const near = claim({ claim_id: 'near', appt_end: '2026-08-19T14:00:00Z', claim_number: '' })
    const far = claim({ claim_id: 'far', appt_end: '2026-06-01T14:00:00Z', claim_number: '' })

    const result = matchClaim('2026-08-19T14:10:00Z', 'Holdridge at 10503 Waters Drive.', [
      far,
      near,
    ])

    expect(result.claim_id).toBe('near')
  })
})

describe('confidence and ambiguity', () => {
  it('reports low confidence on a single weak signal', () => {
    const result = matchClaim(NEXT_DAY, 'Out at the Holdridge place today.', [
      claim({ claim_number: '', address_line1: '', city: '' }),
    ])

    expect(result.claim_id).toBe('claim-1')
    expect(result.match_confidence).toBe('low')
  })

  it('flags ambiguous when two claims score within the delta', () => {
    const a = claim({ claim_id: 'a', claim_number: '' })
    const b = claim({ claim_id: 'b', claim_number: '', appt_end: '' })

    const result = matchClaim(NEXT_DAY, 'Holdridge at 10503 Waters Drive in Irving.', [a, b])

    expect(result.match_method).toBe('ambiguous')
    expect(result.match_confidence).toBe('low')
  })

  it('returns none when the transcript supports no claim', () => {
    const result = matchClaim(NEXT_DAY, 'Shingles are curling on the south slope.', [claim()])

    expect(result.claim_id).toBeNull()
    expect(result.match_method).toBe('none')
  })

  it('returns none when there are no claims at all', () => {
    const result = matchClaim(NEXT_DAY, 'Holdridge at 10503 Waters Drive.', [])

    expect(result.match_method).toBe('none')
  })
})

describe('address normalisation', () => {
  it('matches an abbreviated street type against a spelled out one', () => {
    const result = matchClaim(NEXT_DAY, 'Out at 10503 Waters Dr.', [claim({ claim_number: '' })])

    expect(result.claim_id).toBe('claim-1')
  })
})
