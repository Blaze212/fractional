#!/usr/bin/env node
/**
 * adjuster-core-run.mjs — run the adjuster's portable core on a recording and
 * transcripts from disk, in Node, and print the validated field map.
 *
 * This is the dev loop for a prompt, model, or extraction change: it exercises
 * the exact code apps/adjuster/src/core/ ships to Apps Script, with no Google
 * account, no Drive, no Sheets, and no Apps Script editor in the way. It is
 * also the dev loop for client 2 before any of their infrastructure exists —
 * writing a `deps` object like the one below is the whole of what an adapter
 * has to provide.
 *
 * Zero dependencies. Node 20+.
 *
 * LIVE VENDOR CALLS. This spends real money on OpenRouter and ElevenLabs. It
 * is a developer tool run by hand and is deliberately never wired into
 * `pnpm test` — the default suite replays recorded responses instead (see
 * tests/unit/adjuster/corpus.test.ts).
 *
 *   node scripts/adjuster-core-run.mjs --call path/to/call.json
 *   node scripts/adjuster-core-run.mjs --call call.json --transcribe --format json
 *
 * `--call` is a JSON file. Every path in it resolves relative to that file:
 *
 *   {
 *     "captureId": "local-001",
 *     "callStartedAt": "2026-08-26T18:00:00Z",
 *     "audio": "./recording.wav",           // only needed with --transcribe
 *     "sources": {                          // ignored when --transcribe is set
 *       "elevenlabs": "./elevenlabs.txt",
 *       "qwen": "./qwen.txt",
 *       "dograh": "./dograh.txt"
 *     },
 *     "precedence": ["elevenlabs", "qwen", "dograh"],
 *     "claim": { "claim_id": "claim-1", "insured_last_name": "Henderson" },
 *     "claims": [],                         // candidates, when claim is null
 *     "liveFields": {},                     // the voice platform's own export
 *     "tagSchema": "../apps/adjuster/template/enums.json",
 *     "glossary": "../apps/adjuster/template/glossary.json"
 *   }
 *
 * tagSchema and glossary default to apps/adjuster/template/ when omitted.
 * Keys come from the environment: OPENROUTER_API_KEY (required),
 * OPENROUTER_MODEL, MASTER_TRANSCRIPT_MODEL, OPENROUTER_FALLBACKS,
 * ELEVENLABS_API_KEY (only for --transcribe), ADJUSTER_NAME.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_DIR = resolve(REPO_ROOT, 'apps/adjuster/src/core')

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

/**
 * Loads core into a bare context seeded with `console` and nothing else — the
 * same shape tests/unit/adjuster/loadGs.ts builds. Anything core reaches for
 * outside itself is a ReferenceError here, which is the point.
 */
export function loadCore(coreDir = CORE_DIR) {
  const sandbox = { console }
  vm.createContext(sandbox)

  for (const file of CORE_FILES) {
    const path = resolve(coreDir, file)
    vm.runInContext(readFileSync(path, 'utf-8'), sandbox, { filename: path })
  }

  return sandbox.core
}

/**
 * Core is synchronous by construction — Apps Script has no Promise and no
 * async — so globalThis.fetch cannot be handed to it directly. This runs one
 * fetch in a child Node process and blocks on the result, which is slow (a
 * process per request) and completely fine for a hand-run dev tool. The
 * request and response shapes are core's own, so core cannot tell the
 * difference between this and UrlFetchApp.
 */
export function syncFetch(request) {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const req = JSON.parse(process.argv[1])
      const body = req.payloadIsBytes ? Buffer.from(req.payload) : req.payload
      const headers = Object.assign({}, req.headers)
      if (req.contentType) headers['Content-Type'] = req.contentType
      fetch(req.url, { method: (req.method || 'get').toUpperCase(), headers, body })
        .then(async (res) => {
          process.stdout.write(JSON.stringify({
            status: res.status,
            body: await res.text(),
            headers: Object.fromEntries(res.headers),
          }))
        })
        .catch((err) => {
          process.stderr.write(String(err && err.message ? err.message : err))
          process.exit(1)
        })
      `,
      JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        contentType: request.contentType,
        payload: request.payload,
        payloadIsBytes: Array.isArray(request.payload),
      }),
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  )

  if (child.status !== 0) throw new Error(`fetch failed: ${child.stderr || 'unknown error'}`)

  return JSON.parse(child.stdout)
}

/** The Node half of the contract core/deps.js states. Compare coreDeps.js. */
export function buildNodeDeps({ verbose = false } = {}) {
  return {
    fetch: syncFetch,
    // No fetchAll: core falls back to issuing the same requests one at a time.
    logger: {
      logEvent: (event, fields) => console.error(`[${event}] ${JSON.stringify(fields)}`),
      logServerOnly: (event, fields) => {
        if (verbose) console.error(`[${event}] ${JSON.stringify(fields)}`)
      },
    },
    // Blocking sleep without a busy loop, so retry backoff behaves the way
    // Utilities.sleep does in Apps Script.
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    },
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    stringToBytes: (text) => Array.from(Buffer.from(text, 'utf-8')),
  }
}

export function buildConfigFromEnv(env = process.env) {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set. Core needs a key to call anything.')
  }

  const model = env.OPENROUTER_MODEL || 'openai/gpt-5.4'

  return {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.MASTER_TRANSCRIPT_MODEL || model,
    fallbacks: (env.OPENROUTER_FALLBACKS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    adjusterName: env.ADJUSTER_NAME || 'Brandon',
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || '',
    openRouterApiKey: env.OPENROUTER_API_KEY,
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/** Resolves a call spec's file references into the values core wants. */
export function loadCall(specPath) {
  const path = resolve(specPath)
  const base = dirname(path)
  const spec = readJson(path)
  const at = (value) => resolve(base, value)

  const sources = {}
  Object.entries(spec.sources || {}).forEach(([name, file]) => {
    sources[name] = { text: readFileSync(at(file), 'utf-8') }
  })

  return {
    captureId: spec.captureId || 'local-run',
    callStartedAt: spec.callStartedAt || new Date().toISOString(),
    audioPath: spec.audio ? at(spec.audio) : '',
    sources,
    precedence: spec.precedence,
    claim: spec.claim ?? null,
    claims: spec.claims || [],
    liveFields: spec.liveFields ?? null,
    tagSchema: readJson(
      spec.tagSchema ? at(spec.tagSchema) : resolve(REPO_ROOT, 'apps/adjuster/template/enums.json'),
    ),
    glossary: readJson(
      spec.glossary
        ? at(spec.glossary)
        : resolve(REPO_ROOT, 'apps/adjuster/template/glossary.json'),
    ),
  }
}

/** One line per tag: valid values as-is, NEEDS INPUT where the field did not survive. */
export function renderValidated(validated) {
  const tags = Object.keys(validated)
  const width = Math.max(...tags.map((tag) => tag.length), 0)

  return tags
    .map((tag) => {
      const field = validated[tag]
      const label = tag.padEnd(width)

      if (!field.valid) {
        const heard = field.source_span ? ` (heard: "${field.source_span}")` : ''
        return `${label}  NEEDS INPUT${heard}`
      }
      if (field.empty) return `${label}  —`

      return `${label}  ${field.value}   [${field.confidence}]`
    })
    .join('\n')
}

function parseArgs(argv) {
  const args = { format: 'text' }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--transcribe') args.transcribe = true
    else if (arg === '--verbose') args.verbose = true
    else if (arg === '--call') args.call = argv[++i]
    else if (arg === '--format') args.format = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
  }

  return args
}

function usage() {
  console.log(
    [
      'Usage: node scripts/adjuster-core-run.mjs --call <call.json> [options]',
      '',
      '  --call <path>      Call spec JSON (see the header of this file)',
      '  --transcribe       Run core.transcribe on the spec’s audio first',
      '                     (two extra paid ASR calls) instead of reading the',
      '                     source transcripts off disk',
      '  --format <fmt>     text (default) or json',
      '  --verbose          Include the full vendor request/response log',
      '  --help             This message',
      '',
      'Environment: OPENROUTER_API_KEY (required), OPENROUTER_MODEL,',
      'MASTER_TRANSCRIPT_MODEL, OPENROUTER_FALLBACKS, ELEVENLABS_API_KEY,',
      'ADJUSTER_NAME.',
      '',
      'This makes live vendor calls and costs real money.',
    ].join('\n'),
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.call) {
    usage()
    return
  }

  const core = loadCore()
  const call = loadCall(args.call)
  const config = buildConfigFromEnv()
  const deps = buildNodeDeps({ verbose: args.verbose })

  let sources = call.sources

  if (args.transcribe) {
    if (!call.audioPath) throw new Error('--transcribe needs an "audio" path in the call spec')

    const bytes = Array.from(readFileSync(call.audioPath))
    const transcribed = core.transcribe({
      captureId: call.captureId,
      audio: { bytes, name: call.audioPath.split('/').pop(), contentType: 'audio/wav' },
      format: 'wav',
      keyterms: core.buildKeyterms(call.claim, call.glossary, config.adjusterName),
      config,
      deps,
    })

    // Anything the spec already had on disk stays: the voice platform's own
    // live transcript has no audio to re-read and only ever comes from there.
    sources = Object.assign({}, call.sources, transcribed.sources)
  }

  const result = core.run({
    captureId: call.captureId,
    callStartedAt: call.callStartedAt,
    sources,
    precedence: call.precedence,
    claim: call.claim,
    claims: call.claims,
    tagSchema: call.tagSchema,
    glossary: call.glossary,
    liveFields: call.liveFields,
    config,
    deps,
  })

  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('')
  console.log(`capture_id       ${call.captureId}`)
  console.log(
    `claim            ${result.match.claim_id || '(unmatched)'} (${result.match.match_method})`,
  )
  console.log(`extraction input ${result.manifest.extraction_input}`)
  console.log(
    `master           ${result.master ? `${result.master.accepted ? 'accepted' : 'rejected'} at coverage ${result.master.coverage}` : '(none)'}`,
  )
  console.log('')
  console.log(renderValidated(result.validated))
  console.log('')

  if (result.unplacedNotes.length) {
    console.log('Unplaced notes:')
    result.unplacedNotes.forEach((note) => console.log(`  - ${note}`))
    console.log('')
  }
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
