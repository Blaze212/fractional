import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const {
  resolveTagsForDoc,
  markForReview,
  replaceTag,
  roomLabelsIn,
  collectRoomLabels,
  styleRoomLabels,
  countNeedsInput,
  normalizeClause,
  clauseNeedsReject,
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
  coverage_supporting_detail: {
    label: 'Coverage supporting detail',
    type: 'string',
    required: false,
  },
  // Mirrors the pre-Phase-6 mitigation_status "none" branch: a variant option
  // whose canned text is empty, the exact shape that used to render as an
  // invisible gap.
  mitigation_status: {
    label: 'Mitigation status',
    type: 'variant',
    values: [
      { key: 'none', text: '' },
      { key: 'present', text: 'MITIGATION:\n{{mitigation_narrative}}' },
    ],
  },
}

describe('resolveTagsForDoc', () => {
  it('renders a high-confidence field plainly, with no review flag', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'high', source_span: 'six twelve' },
    }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({ text: '6/12', needsReview: false })
  })

  it('flags a medium-confidence field for review and carries its source_span', () => {
    const validated = {
      roof_pitch: { valid: true, value: '6/12', confidence: 'medium', source_span: 'six twelve' },
    }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({
      text: '6/12',
      needsReview: true,
      sourceSpan: 'six twelve',
    })
  })

  it('renders a needs-input field as a placeholder with no heard hint when there is no source_span', () => {
    const validated = { roof_pitch: { valid: false, empty: false, label: 'Roof pitch' } }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

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

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

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

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mortgage_status).toMatchObject({
      isVariant: true,
      text: 'There is no mortgage on the property.',
      needsReview: true,
      label: 'Mortgage status',
    })
  })

  it('appends a [review: ...] marker to a medium-confidence variant instead of wrapping the whole branch text', () => {
    const validated = {
      mortgage_status: {
        valid: true,
        value: 'no_mortgage',
        confidence: 'medium',
        source_span: 'no mortgage on this one',
      },
    }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)
    const body = { replaceText: (_pattern: string, value: string) => (body.result = value) } as {
      replaceText: (pattern: string, value: string) => void
      result?: string
    }
    replaceTag(body, 'mortgage_status', resolved.mortgage_status)

    expect(body.result).toBe(
      'There is no mortgage on the property. [review: Mortgage status — medium confidence, no transcript citation]',
    )
  })

  it('never flags a variant for review when its value did not match any option key', () => {
    const validated = {
      mortgage_status: { valid: true, value: 'unknown_status', confidence: 'medium' },
    }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mortgage_status).toMatchObject({
      text: '[NEEDS INPUT: Mortgage status]',
      needsReview: false,
    })
  })

  it('renders a validly-omitted field as empty regardless of confidence', () => {
    const validated = { roof_pitch: { valid: true, empty: true, label: 'Roof pitch' } }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.roof_pitch).toMatchObject({ text: '' })
  })

  it('renders an optional field as empty when it validly resolves to nothing', () => {
    const validated = {
      coverage_supporting_detail: { valid: true, empty: true, label: 'Coverage supporting detail' },
    }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.coverage_supporting_detail).toMatchObject({ text: '' })
  })

  it('flags a required variant branch whose canned text is blank instead of rendering an invisible gap', () => {
    const validated = { mitigation_status: { valid: true, value: 'none', confidence: 'high' } }

    const { resolved } = resolveTagsForDoc(validated, tagSchema)

    expect(resolved.mitigation_status).toMatchObject({
      text: '[NEEDS INPUT: Mitigation status]',
      needsReview: false,
    })
  })

  it('never flags an optional field for a blank branch (no such case exists today, but the backstop must not overreach)', () => {
    const optionalTagSchema = {
      coverage_supporting_detail: {
        label: 'Coverage supporting detail',
        type: 'variant',
        required: false,
        values: [{ key: 'blank', text: '' }],
      },
    }
    const validated = {
      coverage_supporting_detail: { valid: true, value: 'blank', confidence: 'high' },
    }

    const { resolved } = resolveTagsForDoc(validated, optionalTagSchema)

    expect(resolved.coverage_supporting_detail.text).toBe('')
  })
})

describe('markForReview', () => {
  it('appends a plain-text heard citation after the real sentence, leaving the sentence itself unmarked', () => {
    const marked = markForReview(
      'The front slope has minor granule loss.',
      'front slope has some wear',
      'Front slope status',
    )

    expect(marked).toBe(
      'The front slope has minor granule loss. [heard: "front slope has some wear"]',
    )
  })

  it('falls back to a review marker naming the field when there is no heard citation to isolate', () => {
    const marked = markForReview(
      'There is no mortgage on the property.',
      undefined,
      'Mortgage status',
    )

    expect(marked).toBe(
      'There is no mortgage on the property. [review: Mortgage status — medium confidence, no transcript citation]',
    )
  })

  it('strips an unbalanced bracket out of the span so the highlight regex still matches', () => {
    const marked = markForReview('6/12', 'the pitch is [about] six twelve', 'Roof pitch')

    expect(marked).toBe('6/12 [heard: "the pitch is about six twelve"]')
  })

  it('truncates a long span with an ellipsis rather than dominating the sentence', () => {
    const longSpan = 'a '.repeat(150).trim()
    const marked = markForReview('value', longSpan, 'Label')

    const citation = marked.slice('value ['.length)
    expect(citation.length).toBeLessThan(longSpan.length)
    expect(marked).toContain('…')
  })
})

// A minimal DocumentApp body double: enough of findText/asText/setBackgroundColor
// to prove highlightMarkers actually paints every marker kind yellow, since the
// pure-string tests above cannot see the highlighting step at all.
describe('highlightMarkers (DocumentApp body double)', () => {
  const { highlightMarkers } = loadGs('apps/adjuster/src/docgen.js')

  function fakeBody(text: string) {
    const highlighted: Array<{ start: number; end: number }> = []
    const pattern = /\[(NEEDS INPUT|heard|review):[^\]]*\]/g
    const matches = Array.from(text.matchAll(pattern))
    let cursor = 0

    const element = {
      asText: () => ({
        setBackgroundColor: (start: number, end: number) => highlighted.push({ start, end }),
      }),
    }

    return {
      highlighted,
      findText: () => {
        if (cursor >= matches.length) return null
        const match = matches[cursor]
        cursor += 1
        return {
          getElement: () => element,
          getStartOffset: () => match.index,
          getEndOffsetInclusive: () => match.index! + match[0].length - 1,
        }
      },
    }
  }

  it('paints a heard citation and a NEEDS INPUT placeholder yellow, leaving the real sentence outside the range', () => {
    const text = 'The roof pitch is 6/12 [heard: "six twelve"]. [NEEDS INPUT: Roof covering type]'
    const body = fakeBody(text)

    highlightMarkers(body)

    expect(body.highlighted).toHaveLength(2)
    const [heard, needsInput] = body.highlighted
    expect(text.slice(heard.start, heard.end + 1)).toBe('[heard: "six twelve"]')
    expect(text.slice(needsInput.start, needsInput.end + 1)).toBe(
      '[NEEDS INPUT: Roof covering type]',
    )
  })

  it('paints a needs-input placeholder that itself carries a heard hint, whole', () => {
    const text = '[NEEDS INPUT: Mitigation details — heard: "ay bee cee restoration"]'
    const body = fakeBody(text)

    highlightMarkers(body)

    expect(body.highlighted).toEqual([{ start: 0, end: text.length - 1 }])
  })

  it('paints a review marker on a medium-confidence variant with no citation', () => {
    const text =
      'There is no mortgage on the property. [review: Mortgage status — medium confidence, no transcript citation]'
    const body = fakeBody(text)

    highlightMarkers(body)

    expect(body.highlighted).toHaveLength(1)
  })

  it('still matches a heard citation whose span survived sanitizeSpan (no stray brackets)', () => {
    const text = 'value [heard: "the pitch is about six twelve"]'
    const body = fakeBody(text)

    highlightMarkers(body)

    expect(body.highlighted).toHaveLength(1)
  })
})

// An omitted optional field (coverage_supporting_detail is the only one that
// sits mid-sentence in every branch today) leaves a gap in the fixed template
// sentence around it — a double space, a stray comma, a space before the
// period. tidyRendering runs the same regex-replace sequence docgen.js sends
// through the real DocumentApp Body.replaceText, so this double just records
// every call and checks the pattern/replacement pairs.
describe('tidyRendering', () => {
  const { tidyRendering } = loadGs('apps/adjuster/src/docgen.js')

  function fakeBody() {
    const calls: Array<{ pattern: string; replacement: string }> = []
    return {
      calls,
      replaceText: (pattern: string, replacement: string) => calls.push({ pattern, replacement }),
    }
  }

  it('collapses a double space left by an omitted mid-sentence optional field', () => {
    const body = fakeBody()

    tidyRendering(body)

    expect(body.calls).toContainEqual({ pattern: '[ ]{2,}', replacement: ' ' })
  })

  it('removes a space before a trailing period or comma', () => {
    const body = fakeBody()

    tidyRendering(body)

    expect(body.calls).toContainEqual({ pattern: ' \\.', replacement: '.' })
    expect(body.calls).toContainEqual({ pattern: ' \\,', replacement: ',' })
  })

  it('collapses a doubled comma left by two adjacent omitted fields', () => {
    const body = fakeBody()

    tidyRendering(body)

    expect(body.calls).toContainEqual({ pattern: ',[ ]*,', replacement: ',' })
  })

  it('strips trailing spaces before a line break', () => {
    const body = fakeBody()

    tidyRendering(body)

    expect(body.calls).toContainEqual({ pattern: '[ ]+\\n', replacement: '\n' })
  })
})

describe('no control characters reach the document', () => {
  it('markForReview never emits a character below \\x20 other than newline', () => {
    const outputs = [
      markForReview('value', 'a span', 'Label'),
      markForReview('value', undefined, 'Label'),
      markForReview('value', 'a span with a ] bracket', 'Label'),
    ]

    outputs.forEach((text) => {
      for (const ch of text) {
        const code = ch.codePointAt(0)!
        if (code < 0x20) expect(ch).toBe('\n')
      }
    })
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

describe('normalizeClause', () => {
  it('lowercases the first character and strips the trailing period', () => {
    expect(normalizeClause('A severe storm.', null)).toBe('a severe storm')
  })

  it('passes an already mid-sentence clause through unchanged', () => {
    expect(normalizeClause('a wind driven rain event', null)).toBe('a wind driven rain event')
  })

  it('strips a restated leading stock prefix', () => {
    expect(normalizeClause('Damage occurred due to a severe storm', null)).toBe('a severe storm')
    expect(normalizeClause('Due to a severe storm', null)).toBe('a severe storm')
    expect(normalizeClause('Resulting in damage to the kitchen ceiling', null)).toBe(
      'the kitchen ceiling',
    )
    expect(normalizeClause('The damages were caused by a severe storm', null)).toBe(
      'a severe storm',
    )
  })

  it('keeps an all-caps acronym capitalized', () => {
    expect(normalizeClause('HVAC failure in the attic', null)).toBe('HVAC failure in the attic')
  })

  it('keeps a proper noun from the matched claim row capitalized', () => {
    const claim = { insured_last_name: 'Whitfield', carrier: 'State Farm' }

    expect(normalizeClause('Whitfield reported the leak himself', claim)).toBe(
      'Whitfield reported the leak himself',
    )
    expect(normalizeClause('State Farm was notified the same day', claim)).toBe(
      'State Farm was notified the same day',
    )
  })

  it('lowercases a capitalized word that is not a claim proper noun, even with a claim present', () => {
    const claim = { insured_last_name: 'Whitfield' }

    expect(normalizeClause('A severe storm.', claim)).toBe('a severe storm')
  })
})

describe('clauseNeedsReject', () => {
  it('accepts a clean mid-sentence clause', () => {
    expect(clauseNeedsReject('a wind driven rain event')).toBe(false)
  })

  it('rejects a normalized value that still reads as two sentences', () => {
    expect(clauseNeedsReject('a severe storm damaged the roof. Water then entered the attic')).toBe(
      true,
    )
  })

  it('rejects a trailing question or exclamation mark', () => {
    expect(clauseNeedsReject('a severe storm, according to the insured!')).toBe(true)
  })

  it('rejects an explicit date, since [DATE_LOSS] already prints one', () => {
    expect(clauseNeedsReject('a severe storm on 4/12/2026')).toBe(true)
    expect(clauseNeedsReject('a severe storm in April')).toBe(true)
  })
})

describe('resolveTagsForDoc: clause fields', () => {
  const clauseSchema = {
    origin_narrative: { label: 'Cause of loss', type: 'narrative', form: 'clause' },
  }

  it('renders a normalized clause plainly', () => {
    const validated = {
      origin_narrative: {
        valid: true,
        value: 'A severe storm.',
        confidence: 'high',
        source_span: 'a severe storm',
      },
    }

    const { resolved, salvaged } = resolveTagsForDoc(validated, clauseSchema)

    expect(resolved.origin_narrative).toMatchObject({ text: 'a severe storm' })
    expect(salvaged).toEqual([])
  })

  it('rejects an unsalvageable clause, flags it, and salvages the raw value into unplaced notes', () => {
    const validated = {
      origin_narrative: {
        valid: true,
        value: 'A severe storm damaged the roof. Water then entered the attic.',
        confidence: 'high',
        source_span: 'a severe storm damaged the roof. water then entered the attic',
      },
    }

    const { resolved, salvaged } = resolveTagsForDoc(validated, clauseSchema)

    expect(resolved.origin_narrative.text).toBe(
      '[NEEDS INPUT: Cause of loss — heard: "a severe storm damaged the roof. water then entered the attic"]',
    )
    expect(salvaged).toEqual([
      'Cause of loss, as extracted: "A severe storm damaged the roof. Water then entered the attic."',
    ])
  })
})
