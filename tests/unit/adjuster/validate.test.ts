import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { validateFields, applyCalendarFallback, validateLiveFields } = loadGs(
  'apps/adjuster/src/validate.js',
)

const transcript =
  'The roof covering is architectural shingle and the pitch is six twelve. There is not a mortgage on the property.'

const tagSchema = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'enum',
    values: ['3-tab asphalt shingle', 'architectural shingle', 'metal', 'tile', 'modified bitumen'],
  },
  roof_pitch: { label: 'Roof pitch', type: 'string' },
  mortgage_company: { label: 'Mortgage company', type: 'string', required: false },
  mortgage_status: {
    label: 'Mortgage status',
    type: 'variant',
    values: [
      {
        key: 'has_mortgage',
        label: 'Has a mortgage',
        text: 'mortgage is through {{mortgage_company}}',
      },
      { key: 'no_mortgage', label: 'No mortgage', text: 'there is not a mortgage on the property' },
    ],
  },
}

describe('validateFields', () => {
  it('accepts a field whose source_span is an exact substring with high confidence', () => {
    const fields = {
      roof_covering_type: {
        value: 'architectural shingle',
        source_span: 'architectural shingle',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_covering_type).toMatchObject({ valid: true, value: 'architectural shingle' })
  })

  it('rejects a fabricated source_span that does not appear in the transcript', () => {
    const fields = {
      roof_pitch: { value: '8/12', source_span: 'pitch is eight twelve', confidence: 'high' },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_pitch).toEqual({ valid: false, empty: false, label: 'Roof pitch' })
  })

  it('rejects a near-miss source_span that differs from the transcript by one word', () => {
    const fields = {
      roof_covering_type: {
        value: 'architectural shingle',
        source_span: 'architectural shingles',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
  })

  it('rejects a value that is not a member of the enum list', () => {
    const fields = {
      roof_covering_type: {
        value: 'wood shake',
        source_span: 'architectural shingle',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
  })

  it('rejects a field with low confidence even when the span matches', () => {
    const fields = {
      roof_pitch: { value: 'six twelve', source_span: 'pitch is six twelve', confidence: 'low' },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_pitch).toEqual({
      valid: false,
      empty: false,
      label: 'Roof pitch',
      source_span: 'pitch is six twelve',
    })
  })

  it('accepts a field with medium confidence, carrying the confidence through', () => {
    const fields = {
      roof_pitch: { value: '6/12', source_span: 'pitch is six twelve', confidence: 'medium' },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_pitch).toMatchObject({ valid: true, value: '6/12', confidence: 'medium' })
  })

  it('does not surface a source_span for a fabricated (unverified) span', () => {
    const fields = {
      roof_pitch: { value: '8/12', source_span: 'pitch is eight twelve', confidence: 'low' },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_pitch).toEqual({ valid: false, empty: false, label: 'Roof pitch' })
  })

  it('treats a missing required field as needing input', () => {
    const result = validateFields({}, transcript, tagSchema)

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
    expect(result.roof_pitch).toEqual({ valid: false, empty: false, label: 'Roof pitch' })
  })

  it('treats a missing optional field as validly omitted, not needing input', () => {
    const result = validateFields({}, transcript, tagSchema)

    expect(result.mortgage_company).toEqual({ valid: true, empty: true, label: 'Mortgage company' })
  })

  it('accepts a variant field whose value matches one of the option keys', () => {
    const fields = {
      mortgage_status: {
        value: 'no_mortgage',
        source_span: 'There is not a mortgage on the property',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.mortgage_status).toMatchObject({ valid: true, value: 'no_mortgage' })
  })

  it('rejects a variant field whose value is not one of the option keys', () => {
    const fields = {
      mortgage_status: {
        value: 'unknown_status',
        source_span: 'There is not a mortgage on the property',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.mortgage_status).toEqual({ valid: false, empty: false, label: 'Mortgage status' })
  })
})

describe('requiredWhen', () => {
  const conditionalSchema = {
    roof_status: {
      label: 'Roof status',
      type: 'variant',
      values: [
        { key: 'not_affected', label: 'Not affected', text: 'not affected' },
        { key: 'shingle', label: 'Shingle', text: 'shingle text' },
      ],
    },
    roof_covering_type: {
      label: 'Roof covering type',
      type: 'enum',
      required: true,
      requiredWhen: { field: 'roof_status', equals: 'shingle' },
      values: ['30 year laminate shingles'],
    },
  }

  it('needs input when the sibling condition is met and the field is missing', () => {
    const fields = {
      roof_status: { value: 'shingle', source_span: 'shingle text', confidence: 'high' },
    }

    const result = validateFields(fields, transcript, conditionalSchema)

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
  })

  it('is validly omitted, not needing input, when the sibling condition is not met', () => {
    const fields = {
      roof_status: { value: 'not_affected', source_span: 'not affected', confidence: 'high' },
    }

    const result = validateFields(fields, transcript, conditionalSchema)

    expect(result.roof_covering_type).toEqual({
      valid: true,
      empty: true,
      label: 'Roof covering type',
    })
  })

  it('is validly omitted when the sibling field is entirely missing', () => {
    const result = validateFields({}, transcript, conditionalSchema)

    expect(result.roof_covering_type).toEqual({
      valid: true,
      empty: true,
      label: 'Roof covering type',
    })
  })
})

describe('applyCalendarFallback', () => {
  const propertySchema = {
    bedroom_count: { label: 'Bedroom count', type: 'enum', values: ['1', '2', '3', '4', '5', '6'] },
    square_footage: { label: 'Interior square footage', type: 'string' },
    year_built: { label: 'Year built', type: 'string' },
    // Deliberately not in CALENDAR_FALLBACK_TAGS — a narrative field must never
    // be filled from an unvalidated calendar value even if present.
    interior_damage_narrative: { label: 'Interior damage narrative', type: 'string' },
  }

  function needsInput(label: string) {
    return { valid: false, empty: false, label }
  }

  it('fills a field the transcript left as needs_input, unvalidated against the transcript', () => {
    const validated = { square_footage: needsInput('Interior square footage') }

    const result = applyCalendarFallback(validated, { square_footage: '2150' }, propertySchema)

    expect(result.square_footage).toEqual({
      valid: true,
      label: 'Interior square footage',
      value: '2150',
      source_span: '',
      confidence: 'calendar',
    })
  })

  it('never overwrites a field the transcript already validated', () => {
    const validated = {
      square_footage: {
        valid: true,
        label: 'Interior square footage',
        value: '1800',
        source_span: 'eighteen hundred square feet',
        confidence: 'high',
      },
    }

    const result = applyCalendarFallback(validated, { square_footage: '2150' }, propertySchema)

    expect(result.square_footage.value).toBe('1800')
    expect(result.square_footage.confidence).toBe('high')
  })

  it("rejects a calendar value outside an enum field's allowed set", () => {
    const validated = { bedroom_count: needsInput('Bedroom count') }

    const result = applyCalendarFallback(validated, { bedroom_count: 'a lot' }, propertySchema)

    expect(result.bedroom_count).toEqual(needsInput('Bedroom count'))
  })

  it('accepts a calendar value that is a valid enum member', () => {
    const validated = { bedroom_count: needsInput('Bedroom count') }

    const result = applyCalendarFallback(validated, { bedroom_count: '4' }, propertySchema)

    expect(result.bedroom_count).toMatchObject({ valid: true, value: '4', confidence: 'calendar' })
  })

  it('leaves a field alone when the calendar has no value for it', () => {
    const validated = { year_built: needsInput('Year built') }

    const result = applyCalendarFallback(validated, {}, propertySchema)

    expect(result.year_built).toEqual(needsInput('Year built'))
  })

  it('never fills a narrative field even if the calendar happens to carry a matching key', () => {
    const validated = { interior_damage_narrative: needsInput('Interior damage narrative') }

    const result = applyCalendarFallback(
      validated,
      { interior_damage_narrative: 'water damage everywhere' },
      propertySchema,
    )

    expect(result.interior_damage_narrative).toEqual(needsInput('Interior damage narrative'))
  })
})

// The generalized rename of validateDograhFields — Dograh's Notetaker export and
// Retell's post-call analysis both hand back a final per-field value with no
// verbatim transcript span, so both platforms go through this same function,
// distinguished only by the `source` argument that lands on each valid field's
// confidence tier.
describe('validateLiveFields', () => {
  it("stamps a valid field's confidence with the passed source, for Dograh", () => {
    const result = validateLiveFields(
      { roof_covering_type: 'architectural shingle' },
      tagSchema,
      'dograh',
    )

    expect(result.roof_covering_type).toEqual({
      valid: true,
      label: 'Roof covering type',
      value: 'architectural shingle',
      source_span: '',
      confidence: 'dograh',
    })
  })

  it("stamps a valid field's confidence with the passed source, for Retell", () => {
    const result = validateLiveFields(
      { roof_covering_type: 'architectural shingle' },
      tagSchema,
      'retell',
    )

    expect(result.roof_covering_type).toEqual({
      valid: true,
      label: 'Roof covering type',
      value: 'architectural shingle',
      source_span: '',
      confidence: 'retell',
    })
  })

  it('rejects a value that is not a member of the enum list, regardless of source', () => {
    const result = validateLiveFields({ roof_covering_type: 'wood shake' }, tagSchema, 'retell')

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
  })

  it('accepts a variant field whose value matches one of the option keys', () => {
    const result = validateLiveFields({ mortgage_status: 'no_mortgage' }, tagSchema, 'retell')

    expect(result.mortgage_status).toEqual({
      valid: true,
      label: 'Mortgage status',
      value: 'no_mortgage',
      source_span: '',
      confidence: 'retell',
    })
  })

  it('rejects a variant field whose value is not one of the option keys', () => {
    const result = validateLiveFields({ mortgage_status: 'unknown_status' }, tagSchema, 'retell')

    expect(result.mortgage_status).toEqual({
      valid: false,
      empty: false,
      label: 'Mortgage status',
    })
  })

  it('always routes a narrative/free-text field to manual review, regardless of source', () => {
    const result = validateLiveFields({ roof_pitch: '6/12' }, tagSchema, 'retell')

    expect(result.roof_pitch).toEqual({ valid: false, empty: false, label: 'Roof pitch' })
  })

  it('treats a missing required field as needing input', () => {
    const result = validateLiveFields({}, tagSchema, 'retell')

    expect(result.roof_covering_type).toEqual({
      valid: false,
      empty: false,
      label: 'Roof covering type',
    })
  })

  it('treats a missing optional field as validly omitted, not needing input', () => {
    const result = validateLiveFields({}, tagSchema, 'retell')

    expect(result.mortgage_company).toEqual({ valid: true, empty: true, label: 'Mortgage company' })
  })
})
