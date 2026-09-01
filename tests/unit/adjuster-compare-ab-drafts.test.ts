import { describe, expect, it } from 'vitest'

// @ts-expect-error standalone zero-dependency script, no type declarations
import {
  DEFAULT_IGNORED_FIELDS,
  diffJobRows,
  formatDiffReport,
} from '../../scripts/adjuster-compare-ab-drafts.mjs'

describe('diffJobRows', () => {
  it('reports a match for every field that is equal on both rows', () => {
    const diff = diffJobRows(
      { insured_last_name: 'Love', city: 'Concord' },
      { insured_last_name: 'Love', city: 'Concord' },
      { ignoreFields: [] },
    )

    expect(diff).toEqual([
      { field: 'insured_last_name', a: 'Love', b: 'Love', match: true, ignored: false },
      { field: 'city', a: 'Concord', b: 'Concord', match: true, ignored: false },
    ])
  })

  it('reports a mismatch for a field that differs and is not ignored', () => {
    const diff = diffJobRows(
      { roof_material: '3-tab' },
      { roof_material: 'metal' },
      {
        ignoreFields: [],
      },
    )

    expect(diff).toEqual([
      { field: 'roof_material', a: '3-tab', b: 'metal', match: false, ignored: false },
    ])
  })

  it('treats an ignored field as matching even when the values differ', () => {
    const diff = diffJobRows(
      { capture_id: 'dograh-1' },
      { capture_id: 'retell-1' },
      { ignoreFields: ['capture_id'] },
    )

    expect(diff).toEqual([
      { field: 'capture_id', a: 'dograh-1', b: 'retell-1', match: true, ignored: true },
    ])
  })

  it('includes a field present on only one side', () => {
    const diff = diffJobRows({ a_only: 'x' }, { b_only: 'y' }, { ignoreFields: [] })

    expect(diff).toEqual([
      { field: 'a_only', a: 'x', b: undefined, match: false, ignored: false },
      { field: 'b_only', a: undefined, b: 'y', match: false, ignored: false },
    ])
  })

  it('ignores the default platform/timestamp fields when no override is passed', () => {
    const diff = diffJobRows(
      { capture_id: 'dograh-1', source: 'dograh', roof_material: '3-tab' },
      { capture_id: 'retell-1', source: 'retell', roof_material: '3-tab' },
    )

    const captureIdEntry = diff.find((entry) => entry.field === 'capture_id')
    const sourceEntry = diff.find((entry) => entry.field === 'source')
    expect(captureIdEntry?.match).toBe(true)
    expect(sourceEntry?.match).toBe(true)
    expect(DEFAULT_IGNORED_FIELDS).toContain('capture_id')
    expect(DEFAULT_IGNORED_FIELDS).toContain('source')
  })
})

describe('formatDiffReport', () => {
  it('reports PASS when every field matches', () => {
    const diff = diffJobRows({ city: 'Concord' }, { city: 'Concord' }, { ignoreFields: [] })

    expect(formatDiffReport(diff)).toContain('PASS — no unignored field differs.')
  })

  it('reports FAIL and names the mismatched fields', () => {
    const diff = diffJobRows(
      { city: 'Concord', roof_material: '3-tab' },
      { city: 'Charlotte', roof_material: '3-tab' },
      { ignoreFields: [] },
    )

    const report = formatDiffReport(diff)
    expect(report).toContain('FAIL — 1 field(s) differ: city')
    expect(report).toContain('a: "Concord"')
    expect(report).toContain('b: "Charlotte"')
  })
})
