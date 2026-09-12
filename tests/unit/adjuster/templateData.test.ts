import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

// enums.json is the repo's source of truth, but the pipeline reads the schema at
// runtime from a Drive file (ENUMS_FILE_ID). The only thing that keeps the two in
// step is a hand-run one-shot sync function carrying a verbatim copy of the JSON —
// so an edit to enums.json that never made it into that copy would look right in
// the repo and change nothing in production. This is the check for that.
describe('enums Drive sync', () => {
  const enums = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'apps/adjuster/template/enums.json'), 'utf-8'),
  )

  function runSync() {
    let written = ''
    const sandbox = loadGs('apps/adjuster/src/templateData.js', {
      DriveApp: {
        getFileById: () => ({
          setContent: (json: string) => {
            written = json
          },
          getId: () => 'enums-file',
        }),
      },
      getConfig: () => 'enums-file',
      logEvent: () => {},
    })

    const syncNames = Object.keys(sandbox).filter((name) =>
      name.startsWith('syncEnumsFileFromRepo_'),
    )
    expect(syncNames, 'exactly one live enums sync function').toHaveLength(1)

    sandbox[syncNames[0]]()
    return written
  }

  it('pushes JSON that parses — a template-literal escape slip breaks this first', () => {
    expect(() => JSON.parse(runSync())).not.toThrow()
  })

  it('pushes exactly what enums.json holds', () => {
    expect(JSON.parse(runSync())).toEqual(enums)
  })
})

// Phase 3 (spec 023): phrasebank.json is loaded the way loadGlossary() loads
// glossary.json, except PHRASEBANK_FILE_ID is optional — a phrase bank is a
// style reference (see prompt.js's "style reference only, do not copy facts
// from it" guard), not schema the pipeline depends on to run, so a missing
// property, a missing Drive file, or bad JSON should all degrade to no phrase
// bank rather than fail the run.
describe('loadPhraseBank', () => {
  it('returns an empty array when PHRASEBANK_FILE_ID is unset', () => {
    const sandbox = loadGs('apps/adjuster/src/templateData.js', {
      getOptionalConfig: (_key: string, fallback: string) => fallback,
      logEvent: () => {},
    })

    expect(sandbox.loadPhraseBank()).toEqual([])
  })

  it('loads and parses the configured Drive file', () => {
    const sandbox = loadGs('apps/adjuster/src/templateData.js', {
      getOptionalConfig: () => 'phrasebank-file-id',
      DriveApp: {
        getFileById: (id: string) => {
          expect(id).toBe('phrasebank-file-id')
          return { getBlob: () => ({ getDataAsString: () => JSON.stringify(['a phrase']) }) }
        },
      },
      logEvent: () => {},
    })

    expect(sandbox.loadPhraseBank()).toEqual(['a phrase'])
  })

  it('returns an empty array, rather than throwing, when the configured file fails to load', () => {
    const sandbox = loadGs('apps/adjuster/src/templateData.js', {
      getOptionalConfig: () => 'phrasebank-file-id',
      DriveApp: {
        getFileById: () => {
          throw new Error('not found')
        },
      },
      describeError: (err: Error) => ({ error: String(err.message ?? err), stack: 'stack' }),
      logEvent: () => {},
    })

    expect(sandbox.loadPhraseBank()).toEqual([])
  })

  it('returns an empty array when the file does not hold a JSON array', () => {
    const sandbox = loadGs('apps/adjuster/src/templateData.js', {
      getOptionalConfig: () => 'phrasebank-file-id',
      DriveApp: {
        getFileById: () => ({ getBlob: () => ({ getDataAsString: () => '{}' }) }),
      },
      logEvent: () => {},
    })

    expect(sandbox.loadPhraseBank()).toEqual([])
  })
})

describe('phrasebank.json', () => {
  it('is a JSON array of plain strings', () => {
    const phraseBank = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'apps/adjuster/template/phrasebank.json'), 'utf-8'),
    )

    expect(Array.isArray(phraseBank)).toBe(true)
    expect(phraseBank.length).toBeGreaterThanOrEqual(20)
    phraseBank.forEach((phrase: unknown) => {
      expect(typeof phrase).toBe('string')
    })
  })

  // Code review follow-up (PR #55): the phrase bank is injected into the
  // prompt as a style reference (see prompt.js's formatPhraseBank), so a
  // spelled-out count here would model exactly the number-format drift
  // Phase 1's "digits over spelled numbers" rule is meant to prevent.
  // "several" is a vague quantifier, not a specific count, and stays a word.
  it('writes countable numbers as digits, matching the register rule it is a reference for', () => {
    const phraseBank = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'apps/adjuster/template/phrasebank.json'), 'utf-8'),
    )
    const spelledOutCountPattern =
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i

    phraseBank.forEach((phrase: string) => {
      expect(phrase).not.toMatch(spelledOutCountPattern)
    })
  })
})
