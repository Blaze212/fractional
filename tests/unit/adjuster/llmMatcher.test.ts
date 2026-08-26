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

function harness(response: unknown) {
  const calls: Array<Record<string, unknown>> = []

  const sandbox = loadGs('apps/adjuster/src/llmMatcher.js', {
    getConfig: (key: string) => {
      if (key === 'OPENROUTER_API_KEY') return 'key'
      if (key === 'OPENROUTER_MODEL') return 'model'
      throw new Error('Missing script property: ' + key)
    },
    getConfigList: () => [],
    buildExtractionSchema: () => ({}),
    callOpenRouter: (config: Record<string, unknown>) => {
      calls.push(config)
      if (response instanceof Error) throw response
      return response
    },
  })

  return { sandbox, calls }
}

describe('matchClaimWithLlm', () => {
  it('returns none without calling the LLM when there are no candidate claims', () => {
    const { sandbox, calls } = harness({ fields: {} })

    const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'some transcript', [])

    expect(result).toEqual({
      claim_id: null,
      match_method: 'none',
      match_confidence: 'none',
      candidates: [],
    })
    expect(calls).toHaveLength(0)
  })

  it('matches the claim the model names, when it is in the candidate pool', () => {
    const { sandbox } = harness({
      fields: {
        claim_id: { value: 'event-1', confidence: 'high' },
        reasoning: { value: 'name and address match' },
      },
    })

    const result = sandbox.matchClaimWithLlm(
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
    const { sandbox } = harness({
      fields: { claim_id: { value: 'not-a-real-id', confidence: 'high' } },
    })

    const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result).toEqual({
      claim_id: null,
      match_method: 'none',
      match_confidence: 'none',
      candidates: [],
    })
  })

  it('returns none when the model returns an empty claim_id', () => {
    const { sandbox } = harness({ fields: { claim_id: { value: '' } } })

    const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result.claim_id).toBeNull()
    expect(result.match_method).toBe('none')
  })

  it('treats anything other than high confidence as low', () => {
    const { sandbox } = harness({
      fields: { claim_id: { value: 'event-1', confidence: 'medium' } },
    })

    const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

    expect(result.match_confidence).toBe('low')
  })
})
