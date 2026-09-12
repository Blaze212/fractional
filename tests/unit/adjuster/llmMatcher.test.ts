import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'
import {
  C1_RAW,
  MATCH_INTEGRITY_CALL_STARTED_AT,
  matchIntegrityClaims,
} from './fixtures/matchIntegrity'

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
    buildExtractionSchema: () => ({ properties: {}, required: [] }),
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

  // docs/specs/022 phase 2 — rejected_values is enforced in code, not trusted
  // from the model's own claim_id choice, mirroring checkVerbatimCoverage()'s
  // "the prompt produces a fact, the code enforces the consequence" shape.
  describe('rejected_values', () => {
    it('drops a candidate whose address the adjuster rejected, even when the model names it', () => {
      const { sandbox } = harness({
        fields: { claim_id: { value: 'event-1', confidence: 'high' } },
        content: { rejected_values: ['5139 Alderman Rd.'] },
      })

      const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

      expect(result).toEqual({
        claim_id: null,
        match_method: 'none',
        match_confidence: 'none',
        candidates: [],
      })
    })

    it('drops a candidate whose insured name the adjuster rejected', () => {
      const { sandbox } = harness({
        fields: { claim_id: { value: 'event-1', confidence: 'high' } },
        content: { rejected_values: ['Talley'] },
      })

      const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

      expect(result.claim_id).toBeNull()
    })

    it('reproduces the c1 fixture: the rejected RAY guess is excluded even when the model names it', () => {
      const claims = matchIntegrityClaims()
      const rayClaimId = claims.find((c) => c.claim_id === 'ray-1')!.claim_id

      const { sandbox } = harness({
        fields: { claim_id: { value: rayClaimId, confidence: 'high' } },
        content: { rejected_values: ['Ray', 'Maple Street'] },
      })

      const result = sandbox.matchClaimWithLlm(MATCH_INTEGRITY_CALL_STARTED_AT, C1_RAW, claims)

      expect(result.claim_id).toBeNull()
      expect(result.match_method).toBe('none')
    })

    it('does not disqualify a candidate no rejected value touches', () => {
      const { sandbox } = harness({
        fields: { claim_id: { value: 'event-1', confidence: 'high' } },
        content: { rejected_values: ['a different street entirely'] },
      })

      const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

      expect(result.claim_id).toBe('event-1')
    })

    it('ignores an absent rejected_values list entirely', () => {
      const { sandbox } = harness({
        fields: { claim_id: { value: 'event-1', confidence: 'high' } },
      })

      const result = sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [claim()])

      expect(result.claim_id).toBe('event-1')
    })
  })
})

describe('buildLlmMatchPrompt', () => {
  it('labels the transcript by speaker', () => {
    const { sandbox, calls } = harness({ fields: { claim_id: { value: '' } } })

    sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'the roof is a six twelve', [claim()])

    expect(calls[0].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({
        content: expect.stringContaining('Adjuster: the roof is a six twelve'),
      }),
    ])
  })

  it('lists every candidate claim', () => {
    const { sandbox, calls } = harness({ fields: { claim_id: { value: '' } } })

    sandbox.matchClaimWithLlm('2026-08-19T16:10:00Z', 'transcript', [
      claim(),
      claim({ claim_id: 'event-2' }),
    ])

    const userMessage = (calls[0].messages as Array<{ content: string }>)[1].content
    expect(userMessage).toContain('event-1')
    expect(userMessage).toContain('event-2')
  })
})

describe('LLM_MATCH_SYSTEM_PROMPT', () => {
  it('instructs the model that an agent proposal is never evidence and to report rejected values', () => {
    const { LLM_MATCH_SYSTEM_PROMPT } = loadGs('apps/adjuster/src/llmMatcher.js')

    expect(LLM_MATCH_SYSTEM_PROMPT).toMatch(/agent's?\s+(?:own\s+)?proposal is never evidence/i)
    expect(LLM_MATCH_SYSTEM_PROMPT).toMatch(/rejected_values/)
    expect(LLM_MATCH_SYSTEM_PROMPT).toMatch(/only the adjuster's own words/i)
  })
})

describe('buildMatchSchema', () => {
  it('adds rejected_values to the schema buildExtractionSchema returns', () => {
    const sandbox = loadGs('apps/adjuster/src/llmMatcher.js', {
      buildExtractionSchema: () => ({
        properties: { fields: {}, unplaced_notes: {} },
        required: ['fields', 'unplaced_notes'],
      }),
    })

    const schema = sandbox.buildMatchSchema()

    expect(schema.properties.rejected_values).toEqual({ type: 'array', items: { type: 'string' } })
    expect(schema.required).toEqual(['fields', 'unplaced_notes', 'rejected_values'])
  })
})
