#!/usr/bin/env node
/**
 * adjuster-corpus-live.mjs — run the adjuster regression corpus against real
 * models and print the field-by-field diff against each fixture's expected
 * output.
 *
 * This is what makes a prompt or model change show its blast radius before it
 * merges. The default `pnpm test` runs the same fixtures through the same core
 * with recorded responses (tests/unit/adjuster/corpus.test.ts); this replaces
 * the replayed responses with live ones and reports what moved.
 *
 * Zero dependencies. Node 20+.
 *
 * LIVE VENDOR CALLS. One merge and one extraction per fixture, on every run.
 * Never wired into `pnpm test` — it runs from
 * .github/workflows/adjuster-corpus-live.yml on manual dispatch or on its
 * schedule, and by hand:
 *
 *   OPENROUTER_API_KEY=... node scripts/adjuster-corpus-live.mjs
 *   OPENROUTER_API_KEY=... node scripts/adjuster-corpus-live.mjs --fixture synthetic-hail-roof
 *
 * Exit code is 0 whether or not fields moved: a diff is information, not a
 * failure. Pass --fail-on-diff to make it a gate.
 *
 * Environment: OPENROUTER_API_KEY (required), OPENROUTER_MODEL,
 * MASTER_TRANSCRIPT_MODEL, OPENROUTER_FALLBACKS, ADJUSTER_NAME.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildConfigFromEnv, buildNodeDeps, loadCore } from './adjuster-core-run.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS_DIR = resolve(REPO_ROOT, 'tests/fixtures/adjuster/calls')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export function listFixtures(dir = CORPUS_DIR) {
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((entry) => existsSync(resolve(dir, entry, 'call.json')))
    .sort()
}

export function loadFixture(name, dir = CORPUS_DIR) {
  const base = resolve(dir, name)
  const at = (file) => resolve(base, file)
  const spec = readJson(at('call.json'))

  const sources = {}
  Object.entries(spec.sources || {}).forEach(([source, file]) => {
    sources[source] = { text: readFileSync(at(file), 'utf-8') }
  })

  const expectedPath = at('expected-validated.json')

  return {
    name,
    captureId: spec.captureId,
    callStartedAt: spec.callStartedAt,
    sources,
    precedence: spec.precedence,
    claim: spec.claim ?? null,
    claims: spec.claims || [],
    liveFields: spec.liveFields ?? null,
    tagSchema: readJson(at(spec.tagSchema || 'tagSchema.json')),
    glossary: readJson(at(spec.glossary || 'glossary.json')),
    expected: existsSync(expectedPath) ? readJson(expectedPath) : null,
  }
}

/**
 * Field by field, in tag order, over the union of both maps. Mirrors
 * diffValidated in tests/unit/adjuster/corpus.ts: it compares what a reader of
 * the draft would notice — whether the field survived and what it says — not
 * the confidence tier or the exact span the model happened to quote, which
 * differ run to run without changing a word of the report.
 */
export function diffValidated(expected, actual) {
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

function describe(field) {
  if (!field) return '(absent)'
  if (!field.valid) return 'NEEDS INPUT'
  if (field.empty) return '(omitted)'
  return JSON.stringify(field.value)
}

export function renderReport(results) {
  const lines = []
  let moved = 0

  results.forEach((result) => {
    lines.push('')
    lines.push(`## ${result.name}`)

    if (result.error) {
      lines.push(`  FAILED: ${result.error}`)
      return
    }

    lines.push(
      `  extraction input: ${result.manifest.extraction_input}` +
        `   master: ${result.master ? `${result.master.accepted ? 'accepted' : 'rejected'} @ ${result.master.coverage.toFixed(3)}` : 'none'}` +
        `   model: ${result.extraction.model || '(unreported)'}`,
    )
    lines.push('')

    if (!result.expected) {
      lines.push('  (no expected-validated.json — nothing to diff against)')
      return
    }

    result.diffs.forEach((diff) => {
      if (diff.same) {
        lines.push(`  ok  ${diff.tag}`)
        return
      }
      moved += 1
      lines.push(`  ->  ${diff.tag}`)
      lines.push(`        was: ${describe(diff.expected)}`)
      lines.push(`        now: ${describe(diff.actual)}`)
    })
  })

  lines.unshift(
    `${results.length} fixture(s), ${moved} field(s) moved against the recorded expectation.`,
  )
  lines.unshift('# Adjuster corpus — live run')

  return { report: lines.join('\n'), moved }
}

function parseArgs(argv) {
  const args = { fixtures: [] }

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixtures.push(argv[++i])
    else if (argv[i] === '--fail-on-diff') args.failOnDiff = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
  }

  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'Usage: OPENROUTER_API_KEY=... node scripts/adjuster-corpus-live.mjs [--fixture <name>] [--fail-on-diff]',
    )
    return
  }

  const core = loadCore()
  const config = buildConfigFromEnv()
  const deps = buildNodeDeps()
  const names = args.fixtures.length ? args.fixtures : listFixtures()

  if (!names.length) {
    console.log('No fixtures under tests/fixtures/adjuster/calls/.')
    return
  }

  const results = names.map((name) => {
    const fixture = loadFixture(name)

    try {
      const run = core.run({
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

      return {
        name,
        expected: fixture.expected,
        master: run.master,
        manifest: run.manifest,
        extraction: run.extraction,
        diffs: fixture.expected ? diffValidated(fixture.expected, run.validated) : [],
      }
      // One fixture's vendor failure must not hide the other fixtures' results,
      // which are the reason the job ran.
    } catch (error) {
      return { name, error: error.message }
    }
  })

  const { report, moved } = renderReport(results)
  console.log(report)

  if (args.failOnDiff && moved > 0) process.exit(1)
  if (results.some((result) => result.error)) process.exit(1)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
