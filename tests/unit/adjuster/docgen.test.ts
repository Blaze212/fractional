import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { resolveTagsForDoc, markForReview } = loadGs('apps/adjuster/src/docgen.js')

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

describe('markForReview', () => {
  const START = '\x02'
  const END = '\x03'

  it('isolates only the heard citation in the review markers, leaving the real sentence unmarked', () => {
    const marked = markForReview(
      'The front slope has minor granule loss.',
      'front slope has some wear',
    )

    expect(marked).toBe(
      'The front slope has minor granule loss.' +
        START +
        ' [heard: "front slope has some wear"]' +
        END,
    )
    expect(marked.indexOf(START)).toBeGreaterThan(marked.indexOf('granule loss.'))
  })

  it('falls back to marking the whole value when there is no heard citation to isolate', () => {
    const marked = markForReview('There is no mortgage on the property.', undefined)

    expect(marked).toBe(START + 'There is no mortgage on the property.' + END)
  })
})

describe('insertHeaderBlock', () => {
  const { insertHeaderBlock } = loadGs('apps/adjuster/src/docgen.js')

  function fakeBody() {
    const paragraphs: string[] = []
    return {
      paragraphs,
      insertParagraph: (_index: number, text: string) => {
        paragraphs.push(text)
        return { editAsText: () => ({ setBold: () => {} }) }
      },
      insertHorizontalRule: () => {},
    }
  }

  const job = {
    capture_id: 'dograh-1',
    call_started_at: '2026-08-26T18:04:00Z',
    duration_sec: 610,
    match_method: 'exact',
    match_confidence: 'high',
    model: 'test-model',
  }

  it('links back to the call folder holding the audio and transcripts', () => {
    const body = fakeBody()

    insertHeaderBlock(body, { ...job, call_folder_id: 'folder-9' }, null, 0)

    expect(body.paragraphs[0]).toContain(
      'Call folder: https://drive.google.com/drive/folders/folder-9',
    )
  })

  it('omits the line entirely for a job that predates per-call foldering', () => {
    const body = fakeBody()

    insertHeaderBlock(body, job, null, 0)

    expect(body.paragraphs[0]).not.toContain('Call folder:')
  })
})
