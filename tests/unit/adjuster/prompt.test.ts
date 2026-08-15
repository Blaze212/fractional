import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildPrompt } = loadGs('apps/adjuster/src/prompt.js')

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
})
