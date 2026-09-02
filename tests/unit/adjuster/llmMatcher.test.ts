import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: 'event-1',
    insured_last_name: 'TALLEY',
    address_line1: '5139 Alderman Rd.',
    city: 'Concord',
    claim_number: 'CLF-00153289',
    appt_end: '2026-08-19T16:00:00Z',
    ...overrides,
  }
}

// config and deps are arguments now, not Script Properties read inside the
// matcher — see spec 021 phase 3.2. The harness supplies both, so a missing
// one shows up as a failing assertion rather than as a stubbed global nobody
// remembered to remove.
const CONFIG = { apiKey: 'key', model: 'model', fallbacks: [] }

function harness(response: unknown) {
  const calls: Array<Record<string, unknown>> = []
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []

  const deps = {
    fetch: () => {
      throw new Error('llmMatcher must not reach the network in a unit test')
    },
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      logServerOnly: () => {},
    },
  }

  const sandbox = loadGs('apps/adjuster/src/llmMatcher.js', {
    buildExtractionSchema: () => ({}),
    callOpenRouter: (config: Record<string, unknown>) => {
      calls.push(config)
      if (response instanceof Error) throw response
      return response
    },
  })

  const matchClaimWithLlm = (callStartedAt: string, transcript: string, claims: unknown[]) =>
    sandbox.matchClaimWithLlm(callStartedAt, transcript, claims, CONFIG, deps)

  return { sandbox, calls, deps, matchClaimWithLlm }
}

describe('matchClaimWithLlm', () => {
  it('returns none without calling the LLM when there are no candidate claims', () => {
    const { calls, matchClaimWithLlm } = harness({ fields: {} })

    const result = matchClaimWithLlm('2026-08-19T16:10:00Z', 'some transcript', [])

    expect(result).toEqual({
      claim_id: null,
      match_method: 'none',
      match_confidence: 'none',
      candidates: [],
    })
    expect(calls).toHaveLength(0)
  })

  it('matches the claim the model names, when it is in the candidate pool', () => {
    const { matchClaimWithLlm } = harness({
      fields: {
        claim_id: { value: 'event-1', confidence: 'high' },
        reasoning: { value: 'name and address match' },
      },
    })

    const result = matchClaimWithLlm(
      '2026-08-19T16:10:00Z',
      "This is Barton at 5139 Alderman, roof's leaking, name's Tally",
      [claim()],
    )

    expect(result).toEqual({
      claim_id: 'event-1',
      match_method: 'llm',
      match_confidence: 'high',
      candidates: [],
    })
  })

  it('never trusts a claim_id the model invents outside the candidate pool', () => {
    const { matchClaimWithLlm } = harness({
      fields: { claim_id: { value: 'not-a-real-id', confidence: 'high' } },
    })

    const result = matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result).toEqual({
      claim_id: null,
      match_method: 'none',
      match_confidence: 'none',
      candidates: [],
    })
  })

  it('returns none when the model returns an empty claim_id', () => {
    const { matchClaimWithLlm } = harness({ fields: { claim_id: { value: '' } } })

    const result = matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result.claim_id).toBeNull()
    expect(result.match_method).toBe('none')
  })

  it('treats anything other than high confidence as low', () => {
    const { matchClaimWithLlm } = harness({
      fields: { claim_id: { value: 'event-1', confidence: 'medium' } },
    })

    const result = matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result.match_confidence).toBe('low')
  })
})

describe('matchClaimWithLlm dependency injection', () => {
  it('passes the injected config and deps straight through to callOpenRouter', () => {
    const { calls, deps, matchClaimWithLlm } = harness({
      fields: { claim_id: { value: 'event-1', confidence: 'high' } },
    })

    matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(calls).toHaveLength(1)
    expect(calls[0].apiKey).toBe('key')
    expect(calls[0].model).toBe('model')
    expect(calls[0].fallbacks).toEqual([])
    expect(calls[0].deps).toBe(deps)
  })

  it('lets a failed call surface to the caller, which decides whether to fail the job', () => {
    const { matchClaimWithLlm } = harness(new Error('OpenRouter request failed: 500'))

    expect(() => matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])).toThrow(
      /OpenRouter request failed/,
    )
  })
})
