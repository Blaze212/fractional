import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const {
  resolveTagsForDoc,
  markForReview,
  roomLabelsIn,
  collectRoomLabels,
  styleRoomLabels,
  countNeedsInput,
} = loadGs('apps/adjuster/src/docgen.js')

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

// Brandon's finished reports write the interior as one block per room, the room
// name bolded and italicised on its own line. The whole narrative arrives as a
// single multi-line string in one paragraph, so the room names are found and
// styled after insertion rather than carried by the {{tag}} replacement.
describe('room-grouped sections', () => {
  const interior = [
    'Master Bedroom:',
    'We observed water damage to the tray ceiling in 2 places. We will estimate to repair the damaged drywall and paint the ceiling.',
    '',
    'Garage:',
    'We observed damage to one outlet that was burned. We will estimate to replace the outlet.',
  ].join('\n')

  it('picks out the room-name lines and nothing else', () => {
    expect(roomLabelsIn(interior)).toEqual(['Master Bedroom:', 'Garage:'])
  })

  it('does not mistake a findings line that happens to contain a colon for a room name', () => {
    expect(roomLabelsIn('Kitchen:\nWe observed the following: two damaged cabinets.')).toEqual([
      'Kitchen:',
    ])
  })

  it('reads level sub-headers on a multi-level property as labels too', () => {
    expect(roomLabelsIn('Main Level:\nKitchen:\nWe observed water staining.')).toEqual([
      'Main Level:',
      'Kitchen:',
    ])
  })

  it('finds nothing in a section that flagged for manual input instead of rendering', () => {
    expect(roomLabelsIn('[NEEDS INPUT: Interior damage findings]')).toEqual([])
  })

  it('collects labels from the interior and other-structures sections without duplicating', () => {
    const resolved = {
      interior_damage_narrative: { text: 'Garage:\nWe observed a burned outlet.' },
      other_structures_narrative: {
        text: 'Garage:\nThe siding is dented.\n\nShed:\nThe roof is damaged.',
      },
      overhead_profit_narrative: { text: 'Overhead and profit are not included.' },
    }

    expect(collectRoomLabels(resolved)).toEqual(['Garage:', 'Shed:'])
  })

  it('bolds and italicises a room name, and leaves the same words mid-line alone', () => {
    const text = 'Damage to the Garage: was noted.\nGarage:\nWe observed a burned outlet.'
    const styled: Array<{ start: number; end: number }> = []
    const element = {
      asText: () => ({
        getText: () => text,
        setBold: (start: number, end: number) => styled.push({ start, end }),
        setItalic: () => {},
      }),
    }
    let cursor = -1
    const body = {
      findText: (pattern: string, from?: unknown) => {
        const at = text.indexOf(pattern, from === undefined ? 0 : cursor + 1)
        if (at === -1) return null
        cursor = at
        return {
          getElement: () => element,
          getStartOffset: () => at,
          getEndOffsetInclusive: () => at + pattern.length - 1,
        }
      },
    }

    styleRoomLabels(body, ['Garage:'])

    const lineStart = text.indexOf('\nGarage:') + 1
    expect(styled).toEqual([{ start: lineStart, end: lineStart + 'Garage:'.length - 1 }])
  })
})

// Two kinds of needs-input reach a draft: a field that failed validation, and a
// field that validated onto a variant branch whose own canned text carries the
// marker. Both are highlighted in the body, so both belong in the header count.
describe('countNeedsInput', () => {
  const schema = {
    roof_pitch: { label: 'Roof pitch', type: 'string' },
    coverage_determination: {
      label: 'Coverage determination',
      type: 'variant',
      values: [
        { key: 'covered', text: 'which is covered under the policy.' },
        {
          key: 'unknown',
          text: 'and coverage is questionable at this time. [NEEDS INPUT: Confirm the coverage determination before filing.]',
        },
      ],
    },
  }

  it('counts a field that failed validation', () => {
    const validated = {
      roof_pitch: { valid: false, empty: false, label: 'Roof pitch' },
      coverage_determination: { valid: true, value: 'covered' },
    }

    expect(countNeedsInput(validated, schema)).toBe(1)
  })

  it('counts an undetermined coverage branch even though the field itself validated', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'high' },
      coverage_determination: { valid: true, value: 'unknown' },
    }

    expect(countNeedsInput(validated, schema)).toBe(1)
  })

  it('counts nothing when every field validated onto a branch that needs no input', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'high' },
      coverage_determination: { valid: true, value: 'covered' },
    }

    expect(countNeedsInput(validated, schema)).toBe(0)
  })

  it('does not count a validly-omitted variant', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'high' },
      coverage_determination: { valid: true, empty: true, label: 'Coverage determination' },
    }

    expect(countNeedsInput(validated, schema)).toBe(0)
  })
})
