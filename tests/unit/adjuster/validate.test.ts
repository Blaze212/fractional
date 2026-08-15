import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { validateFields } = loadGs('apps/adjuster/src/validate.js')

const transcript = 'The roof covering is architectural shingle and the pitch is six twelve.'

const tagSchema = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'enum',
    values: ['3-tab asphalt shingle', 'architectural shingle', 'metal', 'tile', 'modified bitumen'],
  },
  roof_pitch: { label: 'Roof pitch', type: 'string' },
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

    expect(result.roof_pitch).toEqual({ valid: false, label: 'Roof pitch' })
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

    expect(result.roof_covering_type).toEqual({ valid: false, label: 'Roof covering type' })
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

    expect(result.roof_covering_type).toEqual({ valid: false, label: 'Roof covering type' })
  })

  it('rejects a field with low confidence even when the span matches', () => {
    const fields = {
      roof_pitch: { value: 'six twelve', source_span: 'pitch is six twelve', confidence: 'low' },
    }

    const result = validateFields(fields, transcript, tagSchema)

    expect(result.roof_pitch).toEqual({ valid: false, label: 'Roof pitch' })
  })

  it('treats a missing field as needing input', () => {
    const result = validateFields({}, transcript, tagSchema)

    expect(result.roof_covering_type).toEqual({ valid: false, label: 'Roof covering type' })
    expect(result.roof_pitch).toEqual({ valid: false, label: 'Roof pitch' })
  })
})
