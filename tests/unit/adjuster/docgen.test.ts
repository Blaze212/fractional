import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { resolveTagsForDoc } = loadGs('apps/adjuster/src/docgen.js')

const tagSchema = {
  roof_pitch: { label: 'Roof pitch', type: 'string' },
  mitigation_narrative: { label: 'Mitigation details', type: 'string' },
  mortgage_status: {
    label: 'Mortgage status',
    type: 'variant',
    values: [
      { key: 'has_mortgage', text: 'Mortgage confirmed.' },
      { key: 'no_mortgage', text: 'There is no mortgage on the property.' },
    ],
  },
}

describe('resolveTagsForDoc', () => {
  it('renders a high-confidence field plainly, with no review flag', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'high', source_span: 'six twelve' },
    }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({ text: '6/12', needsReview: false })
  })

  it('flags a medium-confidence field for review and carries its source_span', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'medium', source_span: 'six twelve' },
    }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({
      text: '6/12',
      needsReview: true,
      sourceSpan: 'six twelve',
    })
  })

  it('renders a needs-input field as a placeholder with no heard hint when there is no source_span', () => {
    const validated = { roof_pitch: { valid: false, empty: false, label: 'Roof pitch' } }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch.text).toBe('[NEEDS INPUT: Roof pitch]')
  })

  it('attaches a heard hint to a needs-input field that carries a verified (if garbled) source_span', () => {
    const validated = {
      mitigation_narrative: {
        valid: false,
        empty: false,
        label: 'Mitigation details',
        source_span: 'mitigashun was performt by ay bee cee restoration',
      },
    }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mitigation_narrative.text).toBe(
      '[NEEDS INPUT: Mitigation details — heard: "mitigashun was performt by ay bee cee restoration"]',
    )
  })

  it('flags a medium-confidence variant whose value matched an option key', () => {
    const validated = {
      mortgage_status: {
        valid: true,
        value: 'no_mortgage',
        confidence: 'medium',
        source_span: 'no mortgage on this one',
      },
    }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mortgage_status).toMatchObject({
      isVariant: true,
      text: 'There is no mortgage on the property.',
      needsReview: true,
    })
  })

  it('never flags a variant for review when its value did not match any option key', () => {
    const validated = {
      mortgage_status: { valid: true, value: 'unknown_status', confidence: 'medium' },
    }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mortgage_status).toMatchObject({
      text: '[NEEDS INPUT: Mortgage status]',
      needsReview: false,
    })
  })

  it('renders a validly-omitted field as empty regardless of confidence', () => {
    const validated = { roof_pitch: { valid: true, empty: true, label: 'Roof pitch' } }

    const resolved = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({ text: '' })
  })
})
