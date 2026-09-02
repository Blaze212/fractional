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
