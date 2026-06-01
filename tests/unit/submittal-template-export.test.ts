import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import PizZip from 'pizzip'

// Guard: verify that no internal grader fields (gaps, fit_level, must_have_coverage, etc.)
// can ever leak into the client-facing submittal docx by appearing as template tags.
// If a future template edit adds one of these mustache tags, this test will catch it.

const TEMPLATE_PATH = resolve(__dirname, '../../apps/portal/public/submittal-template.docx')

// Internal-only fields that must never appear in the client docx.
const FORBIDDEN_FIELD_PATTERNS = [
  'internal_assessment',
  'fit_level',
  'must_have_coverage',
  'jd_must_haves',
  '{{gaps}}',
  '{{#gaps}}',
  'fit_grade',
  'failure_class',
]

function extractDocxXml(filePath: string): string {
  const buf = readFileSync(filePath)
  const zip = new PizZip(buf)
  const docXml = zip.file('word/document.xml')
  if (!docXml) throw new Error('document.xml not found in docx')
  return docXml.asText()
}

describe('submittal template export — internal field leak guard', () => {
  let docXml: string

  it('can open and read the submittal template', () => {
    docXml = extractDocxXml(TEMPLATE_PATH)
    expect(docXml.length).toBeGreaterThan(100)
  })

  for (const forbidden of FORBIDDEN_FIELD_PATTERNS) {
    it(`does not contain "${forbidden}" in the template XML`, () => {
      if (!docXml) docXml = extractDocxXml(TEMPLATE_PATH)
      expect(docXml).not.toContain(forbidden)
    })
  }

  it('contains the expected client-facing fit fields in the template', () => {
    if (!docXml) docXml = extractDocxXml(TEMPLATE_PATH)
    // Verify the client-facing fields are present so we know the template is loaded.
    expect(docXml).toContain('{{fit_summary}}')
    expect(docXml).toContain('{{#fit_bullets}}')
    expect(docXml).toContain('{{#key_qualifications}}')
  })
})
