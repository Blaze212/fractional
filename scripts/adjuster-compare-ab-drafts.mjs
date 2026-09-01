#!/usr/bin/env node
/**
 * adjuster-compare-ab-drafts.mjs — diff two Jobs-sheet rows field by field.
 *
 * Zero dependencies. Node 20+. Not wired into the app; run it directly, it
 * does not import anything from this repo.
 *
 * Part of the Dograh-vs-Retell A/B call test procedure (see
 * apps/adjuster/docs/dograh-retell-ab-call-runbook.md and
 * docs/specs/017-adjuster-dograh-regression-guard.md). After reading the same
 * script to both the Dograh number and the Retell number, export each call's
 * resulting Jobs-sheet row as JSON (copy the row into a .json file, one
 * object of column-name -> value) and run:
 *
 *   node scripts/adjuster-compare-ab-drafts.mjs dograh-row.json retell-row.json
 *
 * Fields that are expected to differ between the two platforms by design
 * (capture_id, source, transcript_source, timestamps, ...) are ignored by
 * default — pass --field to ignore additional ones, or --all to compare
 * every field with nothing ignored.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Differ by design between any two platforms, or between any two calls at
// all (timestamps) — comparing these would only ever produce noise.
export const DEFAULT_IGNORED_FIELDS = [
  'capture_id',
  'source',
  'transcript_source',
  'created_at',
  'updated_at',
  'call_started_at',
  'call_ended_at',
  'recording_url',
  'audio_drive_id',
  'call_folder_id',
]

// Returns one entry per field present on either row, in the order fields
// first appear across a then b. Ignored fields are still reported (with
// ignored: true) rather than dropped, so a human reading the report can see
// what was intentionally skipped, not just guess.
export function diffJobRows(a, b, { ignoreFields = DEFAULT_IGNORED_FIELDS } = {}) {
  const fields = []
  const seen = new Set()

  for (const key of [...Object.keys(a || {}), ...Object.keys(b || {})]) {
    if (seen.has(key)) continue
    seen.add(key)
    fields.push(key)
  }

  return fields.map((field) => {
    const aValue = (a || {})[field]
    const bValue = (b || {})[field]
    const ignored = ignoreFields.includes(field)
    return {
      field,
      a: aValue,
      b: bValue,
      match: ignored ? true : aValue === bValue,
      ignored,
    }
  })
}

export function formatDiffReport(diff) {
  const lines = []
  const mismatches = diff.filter((entry) => !entry.match)

  for (const entry of diff) {
    const marker = entry.ignored ? '  ~ ' : entry.match ? '  = ' : '  ! '
    lines.push(`${marker}${entry.field}`)
    if (!entry.match) {
      lines.push(`      a: ${JSON.stringify(entry.a)}`)
      lines.push(`      b: ${JSON.stringify(entry.b)}`)
    }
  }

  lines.push('')
  lines.push(
    mismatches.length === 0
      ? 'PASS — no unignored field differs.'
      : `FAIL — ${mismatches.length} field(s) differ: ${mismatches.map((m) => m.field).join(', ')}`,
  )

  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { files: [], ignoreFields: [...DEFAULT_IGNORED_FIELDS] }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--field') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--field needs a value')
      args.ignoreFields.push(value)
      i += 1
    } else if (arg === '--all') {
      args.ignoreFields = []
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      args.files.push(arg)
    }
  }

  return args
}

function usage() {
  console.log(`
adjuster-compare-ab-drafts — diff two Jobs-sheet row exports field by field.

  node scripts/adjuster-compare-ab-drafts.mjs <a.json> <b.json>

  --field <name>  Ignore an additional field (repeatable).
  --all           Compare every field, ignoring nothing.
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.files.length !== 2) {
    usage()
    if (!args.help) process.exitCode = 1
    return
  }

  const [aPath, bPath] = args.files
  const a = JSON.parse(readFileSync(aPath, 'utf8'))
  const b = JSON.parse(readFileSync(bPath, 'utf8'))

  const diff = diffJobRows(a, b, { ignoreFields: args.ignoreFields })
  console.log(formatDiffReport(diff))

  if (diff.some((entry) => !entry.match)) process.exitCode = 1
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
