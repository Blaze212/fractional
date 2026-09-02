import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const {
  validateFields,
  applyCalendarFallback,
  applyClaimPropertyFallback,
  validateLiveFields,
  dropCoverageRestatement,
  collectOffSuggestionFields,
} = loadGs('apps/adjuster/src/validate.js')

const transcript =
  'The roof covering is architectural shingle and the pitch is six twelve. There is not a mortgage on the property.'

const tagSchema = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'string',
    suggestions: [
      '3-tab asphalt shingle',
      'architectural shingle',
      'metal',
      'tile',
      'modified bitumen',
    ],
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

  it('accepts an off-list value for a suggestions field — suggestions are advisory, not enforced', () => {
    const fields = {
      roof_covering_type: {
        value: 'wood shake',
        source_span: 'architectural shingle',
        confidence: 'high',
      },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_covering_type).toMatchObject({ valid: true, value: 'wood shake' })
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
    bedroom_count: {
      label: 'Bedroom count',
      type: 'string',
      suggestions: ['1', '2', '3', '4', '5', '6'],
    },
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

  it('fills an off-list calendar value for a suggestions field — suggestions are advisory, not enforced', () => {
    const validated = { bedroom_count: needsInput('Bedroom count') }

    const result = applyCalendarFallback(validated, { bedroom_count: 'a lot' }, propertySchema)

    expect(result.bedroom_count).toMatchObject({ valid: true, value: 'a lot' })
  })

  it('accepts a calendar value that is a listed suggestion', () => {
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

  it('trusts an off-list value for a suggestions field, regardless of source', () => {
    const result = validateLiveFields({ roof_covering_type: 'wood shake' }, tagSchema, 'retell')

    expect(result.roof_covering_type).toMatchObject({ valid: true, value: 'wood shake' })
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

// The public-records lookup calendar sync runs per claim writes property_* columns
// onto the Claims row (see calendarSync.js). Before this they were written and never
// read, so bed/bath/square footage/year built rendered NEEDS INPUT on every claim
// whose invite description did not spell them out — which is most of them.
describe('applyClaimPropertyFallback', () => {
  const propertySchema = {
    bedroom_count: { label: 'Bedroom count', type: 'string' },
    bathroom_count: { label: 'Bathroom count', type: 'string' },
    square_footage: { label: 'Interior square footage', type: 'string' },
    year_built: { label: 'Year built', type: 'string' },
    // Deliberately outside CLAIM_PROPERTY_FALLBACK_TAGS: a narrative is never
    // filled from a claim row, however tempting a matching column looks.
    interior_damage_narrative: { label: 'Interior damage findings', type: 'string' },
  }

  const claim = {
    claim_id: 'evt-1',
    property_year_built: '1998',
    property_bedrooms: '4',
    property_bathrooms: '2.5',
    property_square_footage: '2150',
    interior_damage_narrative: 'should never be used',
  }

  function needsInput(label: string) {
    return { valid: false, empty: false, label }
  }

  it('fills every property fact the transcript and calendar both left needing input', () => {
    const validated = {
      year_built: needsInput('Year built'),
      bedroom_count: needsInput('Bedroom count'),
      bathroom_count: needsInput('Bathroom count'),
      square_footage: needsInput('Interior square footage'),
    }

    const result = applyClaimPropertyFallback(validated, claim, propertySchema)

    expect(result.year_built).toEqual({
      valid: true,
      label: 'Year built',
      value: '1998',
      source_span: '',
      confidence: 'claim',
    })
    expect(result.bedroom_count.value).toBe('4')
    expect(result.square_footage.value).toBe('2150')
  })

  it('keeps a half bath the old closed enum would have thrown away', () => {
    const validated = { bathroom_count: needsInput('Bathroom count') }

    const result = applyClaimPropertyFallback(validated, claim, propertySchema)

    expect(result.bathroom_count.value).toBe('2.5')
  })

  it('stringifies a numeric sheet cell rather than passing a number downstream', () => {
    const validated = { year_built: needsInput('Year built') }

    const result = applyClaimPropertyFallback(
      validated,
      { property_year_built: 1978 },
      propertySchema,
    )

    expect(result.year_built.value).toBe('1978')
  })

  it('never overwrites a value the transcript or the calendar already supplied', () => {
    const validated = {
      year_built: { valid: true, label: 'Year built', value: '1945', confidence: 'calendar' },
    }

    const result = applyClaimPropertyFallback(validated, claim, propertySchema)

    expect(result.year_built.value).toBe('1945')
  })

  it('leaves a field needing input when the claim row has no value for it', () => {
    const validated = { square_footage: needsInput('Interior square footage') }

    const result = applyClaimPropertyFallback(
      validated,
      { property_square_footage: '' },
      propertySchema,
    )

    expect(result.square_footage).toEqual(needsInput('Interior square footage'))
  })

  it('never fills a narrative field from the claim row', () => {
    const validated = { interior_damage_narrative: needsInput('Interior damage findings') }

    const result = applyClaimPropertyFallback(validated, claim, propertySchema)

    expect(result.interior_damage_narrative).toEqual(needsInput('Interior damage findings'))
  })

  it('is a no-op on an unmatched job with no claim at all', () => {
    const validated = { year_built: needsInput('Year built') }

    const result = applyClaimPropertyFallback(validated, null, propertySchema)

    expect(result.year_built).toEqual(needsInput('Year built'))
  })
})

// The observed bug: cause + "which is covered under the insured's policy" +
// coverage_supporting_detail restating one or both + branch tail said the same
// thing three times. dropCoverageRestatement is the post-pass that catches a
// restated supporting detail after coverage_determination and
// coverage_cause_narrative have both settled.
describe('dropCoverageRestatement', () => {
  function validField(value: string, label = 'x') {
    return { valid: true, label, value, source_span: '', confidence: 'high' }
  }

  it('is a no-op when coverage_supporting_detail was never filled', () => {
    const validated = {
      coverage_supporting_detail: { valid: true, empty: true, label: 'Coverage supporting detail' },
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).toBeNull()
    expect(result.validated.coverage_supporting_detail).toEqual(
      validated.coverage_supporting_detail,
    )
  })

  it('drops a detail that restates the determination ("which is covered")', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'The claim is covered because the damage is storm related.',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('covered'),
      coverage_cause_narrative: validField('storm related'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).toBe(
      'Coverage supporting detail, as extracted: "The claim is covered because the damage is storm related."',
    )
    expect(result.validated.coverage_supporting_detail).toEqual({
      valid: true,
      empty: true,
      label: 'Coverage supporting detail',
    })
  })

  it('drops a detail that restates the cause by content-token overlap', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'Because it is a storm that caused the lightning strike, the claim is covered.',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('covered'),
      coverage_cause_narrative: validField('storm related'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).toContain('Coverage supporting detail, as extracted:')
  })

  it('drops a detail restating "no coverage concerns" even without the word "covered"', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'There are no coverage concerns with this claim.',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('covered'),
      coverage_cause_narrative: validField('storm related'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).not.toBeNull()
  })

  it('keeps an independent supporting detail untouched', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'Heat was maintained in the home throughout the freeze event.',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('covered'),
      coverage_cause_narrative: validField('related to a burst plumbing line due to freezing'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).toBeNull()
    expect(result.validated.coverage_supporting_detail.value).toBe(
      'Heat was maintained in the home throughout the freeze event.',
    )
  })

  it('allows coverage vocabulary in the detail when the determination is unknown', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'The policy was in a lapsed status on the date of loss and is being reviewed by the carrier.',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('unknown'),
      coverage_cause_narrative: validField('storm related'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).toBeNull()
  })

  it('still applies the cause-overlap detector on the unknown branch', () => {
    const validated = {
      coverage_supporting_detail: validField(
        'storm related storm related storm related',
        'Coverage supporting detail',
      ),
      coverage_determination: validField('unknown'),
      coverage_cause_narrative: validField('storm related'),
    }

    const result = dropCoverageRestatement(validated)

    expect(result.dropped).not.toBeNull()
  })
})

// The vocabulary signal for the seven suggestions fields: an off-list value
// still renders (see the "suggestions, not enum" Architecture decision), but
// is worth surfacing so the list can grow from what adjusters actually say.
describe('collectOffSuggestionFields', () => {
  const suggestionsSchema = {
    roof_covering_type: {
      label: 'Roof covering type',
      type: 'string',
      suggestions: ['architectural shingle', 'metal'],
    },
    origin_narrative: { label: 'Cause of loss', type: 'narrative', form: 'clause' },
  }

  it('flags a field whose validated value is not in its suggestions list', () => {
    const validated = {
      roof_covering_type: {
        valid: true,
        label: 'Roof covering type',
        value: 'wood shake',
        confidence: 'high',
      },
    }

    const result = collectOffSuggestionFields(validated, suggestionsSchema)

    expect(result).toEqual([{ tag: 'roof_covering_type', value: 'wood shake', source: 'high' }])
  })

  it('does not flag a value that is in the suggestions list', () => {
    const validated = {
      roof_covering_type: {
        valid: true,
        label: 'Roof covering type',
        value: 'architectural shingle',
        confidence: 'high',
      },
    }

    expect(collectOffSuggestionFields(validated, suggestionsSchema)).toEqual([])
  })

  it('never flags a field with no suggestions list, however unusual its value', () => {
    const validated = {
      origin_narrative: {
        valid: true,
        label: 'Cause of loss',
        value: 'a wind driven rain event',
        confidence: 'high',
      },
    }

    expect(collectOffSuggestionFields(validated, suggestionsSchema)).toEqual([])
  })

  it('skips an invalid or validly-omitted field rather than flagging it', () => {
    const validated = {
      roof_covering_type: { valid: false, empty: false, label: 'Roof covering type' },
    }

    expect(collectOffSuggestionFields(validated, suggestionsSchema)).toEqual([])
  })
})
