import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

function harness() {
  return loadGs('apps/adjuster/src/reviewUi.js', {})
}

describe('tokenizeTemplateText', () => {
  it('splits literal text, {{tag}} chips, and [BRACKET] placeholders', () => {
    const sandbox = harness()

    const tokens = sandbox.tokenizeTemplateText('Hi {{name}}, loss date [DATE_LOSS].')

    expect(tokens).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'tag', tag: 'name' },
      { type: 'text', value: ', loss date ' },
      { type: 'placeholder', name: 'DATE_LOSS' },
      { type: 'text', value: '.' },
    ])
  })

  it('treats a [NEEDS INPUT: ...] marker as literal text, not a placeholder', () => {
    const sandbox = harness()

    const tokens = sandbox.tokenizeTemplateText('ok [NEEDS INPUT: Confirm before filing.] end')

    expect(tokens).toEqual([
      { type: 'text', value: 'ok [NEEDS INPUT: Confirm before filing.] end' },
    ])
  })

  it('returns a single text token for a string with no tokens', () => {
    const sandbox = harness()

    expect(sandbox.tokenizeTemplateText('plain sentence')).toEqual([
      { type: 'text', value: 'plain sentence' },
    ])
  })
})

describe('expandTagBlocks', () => {
  const TAG_SCHEMA = {
    contacted_party_name: { label: 'Contacted party', type: 'string' },
    roof_status: {
      label: 'Roof status',
      type: 'variant',
      values: [
        { key: 'not_affected', text: 'The roof was not affected.' },
        {
          key: 'shingle',
          text: 'Shingles are {{roof_covering_type}}, about {{roof_age_years}} years old.',
        },
      ],
    },
    roof_covering_type: { label: 'Roof covering type', type: 'string' },
    roof_age_years: { label: 'Roof age (years)', type: 'string' },
  }

  it('renders a non-variant reviewable tag as its own chip', () => {
    const sandbox = harness()

    const blocks = sandbox.expandTagBlocks(
      'contacted_party_name',
      { contacted_party_name: { valid: false } },
      TAG_SCHEMA,
      { contacted_party_name: true },
    )

    expect(blocks).toEqual([{ type: 'tag', tag: 'contacted_party_name' }])
  })

  it('renders a non-reviewable resolved tag as plain text, not a chip', () => {
    const sandbox = harness()

    const blocks = sandbox.expandTagBlocks(
      'contacted_party_name',
      { contacted_party_name: { valid: true, value: 'Jane Smith' } },
      TAG_SCHEMA,
      {},
    )

    expect(blocks).toEqual([{ type: 'text', value: 'Jane Smith' }])
  })

  it('keeps an unresolved variant as its own chip instead of expanding', () => {
    const sandbox = harness()

    const blocks = sandbox.expandTagBlocks(
      'roof_status',
      { roof_status: { valid: false } },
      TAG_SCHEMA,
      { roof_status: true },
    )

    expect(blocks).toEqual([{ type: 'tag', tag: 'roof_status' }])
  })

  it('expands a resolved variant into its nested tag chips, regardless of reviewTagSet', () => {
    const sandbox = harness()

    const blocks = sandbox.expandTagBlocks(
      'roof_status',
      {
        roof_status: { valid: true, value: 'shingle' },
        roof_covering_type: { valid: false },
        roof_age_years: { valid: true, value: '12', empty: false },
      },
      TAG_SCHEMA,
      { roof_covering_type: true }, // roof_age_years is high-confidence, never review-eligible
    )

    expect(blocks).toEqual([
      { type: 'text', value: 'Shingles are ' },
      { type: 'tag', tag: 'roof_covering_type' },
      { type: 'text', value: ', about ' },
      { type: 'text', value: '12' },
      { type: 'text', value: ' years old.' },
    ])
  })
})

describe('buildDocBlocks', () => {
  it('builds one blocks array per SECTION_TEMPLATES key', () => {
    const sandbox = harness()
    const tagSchema = { mortgage_status: { label: 'Mortgage status', type: 'variant', values: [] } }

    const bySection = sandbox.buildDocBlocks({}, tagSchema, { mortgage_status: true })

    expect(Object.keys(bySection)).toEqual(Object.keys(sandbox.SECTION_TEMPLATES))
    expect(bySection.Mortgage).toEqual([{ type: 'tag', tag: 'mortgage_status' }])
  })
})

// Guards against SECTION_TEMPLATES (hand-transcribed from
// template/template.flattened.txt) silently drifting from enums.json's real
// section list — a renamed or new section would otherwise fail to appear in
// the doc pane with no test ever catching it.
describe('SECTION_TEMPLATES coverage', () => {
  it('has an entry for every section enums.json actually uses', () => {
    const sandbox = harness()
    const enums = JSON.parse(readFileSync('apps/adjuster/template/enums.json', 'utf-8')) as Record<
      string,
      { section?: string }
    >

    const realSections = new Set(Object.values(enums).map((field) => field.section))

    realSections.forEach((section) => {
      expect(Object.keys(sandbox.SECTION_TEMPLATES)).toContain(section)
    })
  })
})
