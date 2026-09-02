import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

// Loading and running the adjuster regression corpus. Shared by the default
// suite (corpus.test.ts, recorded responses, zero network) and by the opt-in
// live job (scripts/adjuster-corpus-live.mjs, real models). Both run the same
// fixtures through the same core so a live diff means a model changed its mind,
// never that the two harnesses disagree about how to set the call up.

export const CORPUS_DIR = 'tests/fixtures/adjuster/calls'

// index.js last by convention rather than necessity: core/index.js's entries
// are wrappers, so they resolve at call time and this list could be in any
// order. Kept as the natural reading order — dependencies first, the contract
// object last.
const CORE_FILES = [
  'deps.js',
  'matcher.js',
  'llmMatcher.js',
  'prompt.js',
  'openrouter.js',
  'masterTranscript.js',
  'transcription.js',
  'validate.js',
  'pipeline.js',
  'index.js',
]

export type ValidatedField = {
  valid: boolean
  empty?: boolean
  label: string
  value?: string
  source_span?: string
  confidence?: string
}

export type Validated = Record<string, ValidatedField>

export type Fixture = {
  name: string
  dir: string
  captureId: string
  callStartedAt: string
  sources: Record<string, { text: string }>
  precedence?: string[]
  claim: Record<string, unknown> | null
  claims: Array<Record<string, unknown>>
  liveFields: Record<string, unknown> | null
  tagSchema: Record<string, any>
  glossary: Array<Record<string, unknown>>
  responses: Record<string, unknown>
  expected: Validated | null
}

/**
 * Core in a bare context seeded with `console` and nothing else. Anything core
 * reaches for outside itself is a ReferenceError here, which is the point.
 */
export function loadCore(root = process.cwd()): Record<string, any> {
  const sandbox: Record<string, unknown> = { console }
  vm.createContext(sandbox)

  for (const file of CORE_FILES) {
    const full = path.resolve(root, 'apps/adjuster/src/core', file)
    vm.runInContext(readFileSync(full, 'utf-8'), sandbox, { filename: full })
  }

  return sandbox.core as Record<string, any>
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

export function listFixtures(root = process.cwd()): string[] {
  const dir = path.resolve(root, CORPUS_DIR)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((entry) => existsSync(path.join(dir, entry, 'call.json')))
    .sort()
}

export function loadFixture(name: string, root = process.cwd()): Fixture {
  const dir = path.resolve(root, CORPUS_DIR, name)
  const at = (file: string) => path.resolve(dir, file)
  const spec = readJson(at('call.json'))

  const sources: Record<string, { text: string }> = {}
  Object.entries(spec.sources || {}).forEach(([source, file]) => {
    sources[source] = { text: readFileSync(at(file as string), 'utf-8') }
  })

  const expectedPath = at('expected-validated.json')

  return {
    name,
    dir,
    captureId: spec.captureId,
    callStartedAt: spec.callStartedAt,
    sources,
    precedence: spec.precedence,
    claim: spec.claim ?? null,
    claims: spec.claims || [],
    liveFields: spec.liveFields ?? null,
    tagSchema: readJson(at(spec.tagSchema || 'tagSchema.json')),
    glossary: readJson(at(spec.glossary || 'glossary.json')),
    responses: existsSync(at('responses.json')) ? readJson(at('responses.json')) : {},
    expected: existsSync(expectedPath) ? readJson(expectedPath) : null,
  }
}

/**
 * A deps.fetch that answers from the fixture's recorded responses, dispatched
 * on the JSON-schema name in the request core built. Deterministic, free, and
 * it preserves the sandbox invariant that `pnpm test` cannot dial a vendor: an
 * unrecorded schema throws rather than falling through to the network.
 */
export function replayFetch(fixture: Fixture) {
  const seen: string[] = []

  const fetch = (request: Record<string, any>) => {
    const payload = JSON.parse(request.payload)
    const schema = payload?.response_format?.json_schema?.name ?? 'extraction'
    seen.push(schema)

    const recorded = (fixture.responses as Record<string, unknown>)[schema]
    if (recorded === undefined) {
      throw new Error(
        `${fixture.name}: no recorded response for schema "${schema}". ` +
          'Record one in responses.json rather than letting the suite reach a vendor.',
      )
    }

    return { status: 200, body: JSON.stringify(recorded), headers: {} }
  }

  return { fetch, seen }
}

export function collectingLogger() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []

  return {
    events,
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
      logServerOnly: () => {},
    },
  }
}

/** Runs one fixture through core.run with whatever deps the caller supplies. */
export function runFixture(
  core: Record<string, any>,
  fixture: Fixture,
  deps: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  return core.run({
    captureId: fixture.captureId,
    callStartedAt: fixture.callStartedAt,
    sources: fixture.sources,
    precedence: fixture.precedence,
    claim: fixture.claim,
    claims: fixture.claims,
    tagSchema: fixture.tagSchema,
    glossary: fixture.glossary,
    liveFields: fixture.liveFields,
    config,
    deps,
  })
}

/** The config shape a replayed run needs: real enough to build a request with. */
export const REPLAY_CONFIG = {
  apiKey: 'fixture-key',
  model: 'fixture-model',
  fallbacks: [],
  adjusterName: 'Brandon',
}

export type FieldDiff = {
  tag: string
  expected: ValidatedField | undefined
  actual: ValidatedField | undefined
  same: boolean
}

/**
 * Field by field, in tag order, over the union of both maps. Compares what a
 * reader of the draft would notice — whether the field survived, and what it
 * says — not the confidence tier or the exact span the model happened to quote,
 * which differ run to run without changing a word of the report.
 */
export function diffValidated(expected: Validated, actual: Validated): FieldDiff[] {
  const tags = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])].sort()

  return tags.map((tag) => {
    const a = (expected || {})[tag]
    const b = (actual || {})[tag]
    const same =
      Boolean(a) === Boolean(b) &&
      a?.valid === b?.valid &&
      Boolean(a?.empty) === Boolean(b?.empty) &&
      (a?.value ?? '') === (b?.value ?? '')

    return { tag, expected: a, actual: b, same }
  })
}

export function renderFieldDiff(diffs: FieldDiff[]): string {
  const describe = (field: ValidatedField | undefined) => {
    if (!field) return '(absent)'
    if (!field.valid) return 'NEEDS INPUT'
    if (field.empty) return '(omitted)'
    return JSON.stringify(field.value)
  }

  return diffs
    .map(
      (diff) =>
        `${diff.same ? '  ' : '! '}${diff.tag}\n` +
        `      expected: ${describe(diff.expected)}\n` +
        `      actual:   ${describe(diff.actual)}`,
    )
    .join('\n')
}
