import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildPrompt, formatFieldGuidance } = loadGs('apps/adjuster/src/prompt.js')

const templateSpec = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'enum',
    values: ['3-tab asphalt shingle', 'architectural shingle'],
  },
  roof_pitch: { label: 'Roof pitch', type: 'string' },
}

describe('buildPrompt', () => {
  it('includes the source_span requirement in the system prompt', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/source_span/)
    expect(system).toMatch(/exact/i)
  })

  it('lists every tag with its label and enum values', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).toContain('roof_covering_type')
    expect(user).toContain('Roof covering type')
    expect(user).toContain('3-tab asphalt shingle')
    expect(user).toContain('roof_pitch')
  })

  it('includes the claim context when a claim is provided', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      claim: { insured_last_name: 'Whitfield', address_line1: '412 Maple St' },
    })

    expect(user).toContain('Whitfield')
    expect(user).toContain('412 Maple St')
  })

  it('notes when no claim was matched', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec, claim: null })

    expect(user).toMatch(/no claim matched/i)
  })

  it('includes the glossary and phrase bank when provided', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      glossary: [
        {
          term: 'sistering',
          definition: 'reinforcing a joist by attaching a new one alongside it',
        },
      ],
      phraseBank: ['minor granule loss consistent with age'],
    })

    expect(user).toContain('sistering')
    expect(user).toContain('minor granule loss consistent with age')
  })

  it('omits glossary and phrase bank sections when not provided', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).not.toMatch(/trade glossary/i)
    expect(user).not.toMatch(/phrase bank/i)
  })

  it('includes the full transcript verbatim', () => {
    const transcript = 'Twelve minutes of dictation about a roof and a fence.'
    const { user } = buildPrompt({ transcript, templateSpec })

    expect(user).toContain(transcript)
  })

  it('instructs enum fields to send extra descriptive detail to unplaced_notes', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/unplaced_notes/)
    expect(system).toMatch(/closest matching allowed value/i)
  })

  it('instructs the empty-value convention instead of the impossible omit-the-field instruction', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/value "" and source_span ""/)
    expect(system).toMatch(/NEEDS INPUT/)
    expect(system).not.toMatch(/omit that field/i)
  })

  it('instructs spans to be copied verbatim including transcription errors', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/verbatim/i)
    expect(system).toMatch(/transcription errors/i)
  })

  it('forbids choosing a status variant from silence', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/affirmative statement/i)
    expect(system).toMatch(/silence/i)
  })

  it('forbids using the claim context as a source for field values', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/never as a source for field values/i)
  })

  it('omits the field-specific guidance section when no relevant tags are present', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).not.toMatch(/field-specific guidance/i)
  })
})

describe('field-specific guidance', () => {
  it('surfaces guidance only for tags present in templateSpec', () => {
    const spec = {
      roof_damage_narrative: { label: 'Roof damage findings', type: 'narrative' },
      coinsurance_narrative: { label: 'Coinsurance', type: 'narrative' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('Field-specific guidance:')
    expect(user).toContain('roof_damage_narrative:')
    expect(user).toContain('coinsurance_narrative:')
    expect(user).not.toContain('roof_narrative_freeform:')
  })

  it('tells mortgage_company to stay empty rather than guess a lender', () => {
    const spec = {
      mortgage_company: { label: 'Mortgage company', type: 'string' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('mortgage_company:')
    expect(user).toMatch(/never guess a lender/i)
  })

  it('formatFieldGuidance returns an empty string when nothing matches', () => {
    expect(formatFieldGuidance({ some_unrelated_tag: { label: 'x', type: 'string' } })).toBe('')
  })
})

describe('variant fields in the tag list', () => {
  it('lists allowed variant keys, which validateFields matches on exactly', () => {
    const spec = {
      mortgage_status: {
        type: 'variant',
        label: 'Mortgage',
        values: [
          { key: 'has_mortgage', text: 'a' },
          { key: 'no_mortgage', text: 'b' },
        ],
      },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('allowed values: has_mortgage, no_mortgage')
  })

  it('does not leak the rendered variant text into the field list', () => {
    const spec = {
      mortgage_status: {
        type: 'variant',
        values: [{ key: 'has_mortgage', text: 'I confirmed the mortgage is through X.' }],
      },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).not.toContain('I confirmed the mortgage is through X.')
  })
})
