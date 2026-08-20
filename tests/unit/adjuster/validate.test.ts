import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { validateFields } = loadGs('apps/adjuster/src/validate.js')

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
