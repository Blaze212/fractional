#!/usr/bin/env node
/**
 * adjuster-asr-eval.mjs — score Retell / ElevenLabs / Qwen transcripts of the
 * same call against apps/adjuster/template/glossary.json's trade-term
 * vocabulary plus each call's proper nouns (names, insurers, addresses —
 * call-specific, so not in the static glossary).
 *
 * Zero dependencies. Node 20+ (uses built-in fs/path). Not wired into the
 * app; run it directly, it does not import anything from this repo.
 *
 *   node scripts/adjuster-asr-eval.mjs --calls path/to/manifest.json
 *   node scripts/adjuster-asr-eval.mjs --calls path/to/manifest.json \
 *     --glossary apps/adjuster/template/glossary.json --out report.md
 *
 * Manifest is a JSON array, one entry per call, each transcript field a file
 * path resolved relative to the manifest file:
 *
 *   [
 *     {
 *       "callId": "call-001",
 *       "reference": "./call-001/reference.txt",
 *       "retell": "./call-001/retell.txt",
 *       "elevenlabs": "./call-001/elevenlabs.txt",
 *       "qwen": "./call-001/qwen.txt",
 *       "properNouns": ["Dana Whitfield", "Meridian Mutual", "Oak Hollow Drive"]
 *     }
 *   ]
 *
 * "reference" is a human-verified transcript of what was actually said on
 * the call (ground truth) — not produced by any ASR source. This harness
 * does not place calls or call any ASR API itself; see docs/specs/
 * 018-adjuster-retell-asr-eval-harness.md for the full manual workflow.
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCES = ['retell', 'elevenlabs', 'qwen']

/**
 * Lowercase, strip punctuation (hyphens included — "drip-edge" and "drip
 * edge" must compare equal, since ASR sources are inconsistent about
 * hyphenation), collapse whitespace.
 */
export function normalizeForMatch(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pulls the flat term list out of a parsed glossary.json array. */
export function extractGlossaryTerms(glossary) {
  return glossary.map((entry) => entry.term)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Word-boundary-safe check: does `term` occur in `transcriptText`, after normalizing both? */
export function termOccursIn(term, transcriptText) {
  const normalizedTerm = normalizeForMatch(term)
  if (!normalizedTerm) return false

  const normalizedTranscript = normalizeForMatch(transcriptText)
  const pattern = new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`)
  return pattern.test(normalizedTranscript)
}

/**
 * The vocabulary this specific call actually exercises: the subset of
 * glossaryTerms ∪ properNouns that occurs in the reference (ground-truth)
 * transcript. This is the denominator every source is scored against for
 * this call — scoring a source as "missing" a term nobody said would be
 * wrong.
 */
export function findExpectedTerms({ referenceText, glossaryTerms, properNouns = [] }) {
  const candidates = [...glossaryTerms, ...properNouns]
  const seen = new Set()
  const expected = []

  for (const term of candidates) {
    const key = normalizeForMatch(term)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (termOccursIn(term, referenceText)) expected.push(term)
  }
  return expected
}

/** Scores one transcript against the expected-term list for its call. */
export function scoreTranscript({ transcriptText, expectedTerms }) {
  const matched = []
  const missed = []

  for (const term of expectedTerms) {
    if (termOccursIn(term, transcriptText)) matched.push(term)
    else missed.push(term)
  }

  const accuracy = expectedTerms.length === 0 ? 1 : matched.length / expectedTerms.length
  return { matched, missed, accuracy }
}

/**
 * Scores one call's three ASR sources against its reference transcript.
 * `call.sources` holds already-loaded transcript text (not file paths) for
 * retell/elevenlabs/qwen — file resolution is main()'s job, not this
 * function's, so it stays pure and unit-testable.
 */
export function scoreCall(call, glossaryTerms) {
  const expectedTerms = findExpectedTerms({
    referenceText: call.referenceText,
    glossaryTerms,
    properNouns: call.properNouns ?? [],
  })

  const sources = {}
  for (const source of SOURCES) {
    sources[source] = scoreTranscript({
      transcriptText: call.sources[source],
      expectedTerms,
    })
  }

  return { callId: call.callId, expectedTerms, sources }
}

export function scoreCalls(calls, glossaryTerms) {
  return calls.map((call) => scoreCall(call, glossaryTerms))
}

/**
 * Micro-average per source across every call: sum(matched) / sum(expected).
 * Calls with zero expected terms are excluded — nothing to score, and
 * including them would let an empty call inflate or deflate the ranking.
 */
export function aggregateBySource(callScores) {
  const aggregate = {}
  for (const source of SOURCES) aggregate[source] = { matched: 0, expected: 0 }

  for (const call of callScores) {
    if (call.expectedTerms.length === 0) continue
    for (const source of SOURCES) {
      aggregate[source].matched += call.sources[source].matched.length
      aggregate[source].expected += call.expectedTerms.length
    }
  }

  for (const source of SOURCES) {
    const bucket = aggregate[source]
    bucket.accuracy = bucket.expected === 0 ? null : bucket.matched / bucket.expected
  }
  return aggregate
}

/** Sources ranked by accuracy, highest first. */
export function rankSources(aggregate) {
  return SOURCES.map((source) => ({ source, ...aggregate[source] })).sort((a, b) => {
    if (a.accuracy == null) return 1
    if (b.accuracy == null) return -1
    return b.accuracy - a.accuracy
  })
}

function pct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

const SOURCE_LABELS = { retell: 'Retell', elevenlabs: 'ElevenLabs', qwen: 'Qwen' }

/** Renders the ranking + per-call breakdown as a markdown report. */
export function renderMarkdownReport({ callScores, aggregate, ranking, meta = {} }) {
  const lines = []
  lines.push('# Adjuster ASR Vocabulary-Accuracy Comparison')
  lines.push('')
  lines.push(
    `Generated ${meta.generatedAt ?? new Date().toISOString()} · glossary ${meta.glossaryPath ?? 'apps/adjuster/template/glossary.json'} · ${meta.callCount ?? callScores.length} call(s)`,
  )
  lines.push('')
  lines.push(
    '> Directional signal only. See docs/specs/018-adjuster-retell-asr-eval-harness.md — ' +
      'the streaming-only-vs-displace-a-batch-source decision is deferred until this has been ' +
      'run against real calls.',
  )
  lines.push('')

  lines.push('## Ranking')
  lines.push('')
  lines.push('| Rank | Source | Accuracy | Matched | Expected |')
  lines.push('| --- | --- | --- | --- | --- |')
  ranking.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${SOURCE_LABELS[row.source] ?? row.source} | ${pct(row.accuracy)} | ${row.matched} | ${row.expected} |`,
    )
  })
  lines.push('')

  lines.push('## Per-call breakdown')
  lines.push('')
  for (const call of callScores) {
    lines.push(`### ${call.callId}`)
    lines.push('')
    if (call.expectedTerms.length === 0) {
      lines.push('_No glossary or proper-noun terms found in the reference transcript._')
      lines.push('')
      continue
    }
    lines.push(`Expected terms: ${call.expectedTerms.join(', ')}`)
    lines.push('')
    lines.push('| Source | Accuracy | Missed |')
    lines.push('| --- | --- | --- |')
    for (const source of SOURCES) {
      const result = call.sources[source]
      const missed = result.missed.length ? result.missed.join(', ') : '—'
      lines.push(`| ${SOURCE_LABELS[source]} | ${pct(result.accuracy)} | ${missed} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { format: 'md' }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }

    if (arg === '--calls' || arg === '-c') args.calls = next()
    else if (arg === '--glossary' || arg === '-g') args.glossary = next()
    else if (arg === '--out' || arg === '-o') args.out = next()
    else if (arg === '--format' || arg === '-f') args.format = next()
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown flag "${arg}"`)
  }
  return args
}

function usage() {
  console.log(`
adjuster-asr-eval — score Retell/ElevenLabs/Qwen transcripts against the
adjuster glossary's trade terms and each call's proper nouns.

  --calls, -c      Path to the call manifest JSON. Required.
  --glossary, -g   Path to glossary.json. Default: apps/adjuster/template/glossary.json
  --out, -o        Report output file. Default: stdout.
  --format, -f     "md" (default) or "json".

See docs/specs/018-adjuster-retell-asr-eval-harness.md for the manifest shape.
`)
}

function readTextFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} file not found: ${path}`)
  return readFileSync(path, 'utf8')
}

function loadManifest(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8')
  const entries = JSON.parse(raw)
  const baseDir = dirname(resolve(manifestPath))

  return entries.map((entry) => {
    if (!entry.callId) throw new Error('Manifest entry is missing "callId"')

    const referenceText = readTextFile(
      resolve(baseDir, entry.reference),
      `${entry.callId} reference`,
    )
    const sources = {}
    for (const source of SOURCES) {
      if (!entry[source]) throw new Error(`${entry.callId} is missing "${source}"`)
      sources[source] = readTextFile(resolve(baseDir, entry[source]), `${entry.callId} ${source}`)
    }

    return {
      callId: entry.callId,
      referenceText,
      sources,
      properNouns: entry.properNouns ?? [],
    }
  })
}

function loadGlossary(glossaryPath) {
  const raw = readFileSync(glossaryPath, 'utf8')
  return JSON.parse(raw)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.calls) {
    usage()
    return
  }

  const glossaryPath = args.glossary
    ? resolve(args.glossary)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps/adjuster/template/glossary.json')

  const glossary = loadGlossary(glossaryPath)
  const glossaryTerms = extractGlossaryTerms(glossary)
  const calls = loadManifest(args.calls)

  const callScores = scoreCalls(calls, glossaryTerms)
  const aggregate = aggregateBySource(callScores)
  const ranking = rankSources(aggregate)

  let output
  if (args.format === 'json') {
    output = JSON.stringify({ callScores, aggregate, ranking }, null, 2)
  } else if (args.format === 'md') {
    output = renderMarkdownReport({
      callScores,
      aggregate,
      ranking,
      meta: { generatedAt: new Date().toISOString(), glossaryPath, callCount: calls.length },
    })
  } else {
    throw new Error(`Unknown --format "${args.format}". Use "md" or "json".`)
  }

  if (args.out) {
    writeFileSync(args.out, `${output}\n`)
    console.log(`Report written to ${resolve(args.out)}`)
  } else {
    console.log(output)
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
