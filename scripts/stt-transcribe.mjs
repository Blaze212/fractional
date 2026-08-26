#!/usr/bin/env node
/**
 * stt-transcribe.mjs — standalone OpenRouter speech-to-text runner.
 *
 * Zero dependencies. Node 20+ (uses built-in fetch). Not wired into the app;
 * run it directly, it does not import anything from this repo.
 *
 *   export OPENROUTER_API_KEY=sk-or-...
 *   node scripts/stt-transcribe.mjs --model qwen --file ./chunk-01.wav
 *   node scripts/stt-transcribe.mjs --model qwen,gpt,whisper --file ./chunk-01.wav
 *
 * The vocab file lives next to this script (scripts/vocab.txt by default).
 * Lines starting with # are comments, blank lines are dropped, and the rest are
 * joined with ", " into a single biasing string. Put prose on one line if you
 * want free-form context instead of a term list.
 *
 * ---------------------------------------------------------------------------
 * RECOMMENDED MODELS TO TEST (aliases are seeded in the MODELS table below)
 * ---------------------------------------------------------------------------
 * alias          OpenRouter model ID                    proper name
 * qwen           qwen/qwen3-asr-flash-2026-02-10        Qwen: Qwen3 ASR Flash
 * gpt            openai/gpt-transcribe                  OpenAI: GPT Transcribe
 * whisper        openai/whisper-large-v3                OpenAI: Whisper Large V3
 * whisper-turbo  openai/whisper-large-v3-turbo          OpenAI: Whisper Large V3 Turbo
 *
 * Cost for 10 minutes of audio (2 x 5 min), from the OpenRouter catalog:
 *   qwen           $0.000035/second       ~$0.021   vocabulary biasing: yes
 *   gpt            $0.0045/minute         ~$0.045   vocabulary biasing: yes
 *   whisper (groq) $0.111/hour            ~$0.019   vocabulary biasing: yes
 *   whisper-turbo  $0.04/hour  (groq)     ~$0.007   vocabulary biasing: yes
 *
 * Watch the units. OpenRouter bills each model in its provider's native unit,
 * so the raw catalog numbers are per-second for some models, per-minute for
 * others and per-hour for others. The UNIT field below records which.
 *
 * Whisper defaults to the Groq provider because Groq is the only route
 * OpenRouter documents for passing vocabulary through. DeepInfra serves the
 * same model at $0.0000075/second (~$0.0045 for 10 min) with no vocab support:
 *   --model whisper --provider deepinfra --no-vocab
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions'
const DEFAULT_VOCAB_FILE = 'vocab.txt'

/**
 * price/unit are the catalog rate, used only to sanity-check the cost the API
 * reports back. usage.cost from the response is always the authoritative number.
 *
 * vocabField is the key inside provider.options[provider]. OpenRouter only
 * documents this for Groq ("prompt"). The alibaba and openai keys below are the
 * providers' own native parameter names and are the most likely mapping, but
 * they are unverified — run --dry-run to inspect, and use --vocab-field to
 * override without editing this file.
 */
export const MODELS = {
  qwen: {
    id: 'qwen/qwen3-asr-flash-2026-02-10',
    label: 'Qwen3 ASR Flash',
    provider: 'alibaba',
    vocabField: 'context',
    price: 0.000035,
    unit: 'second',
  },
  gpt: {
    id: 'openai/gpt-transcribe',
    label: 'GPT Transcribe',
    provider: 'openai',
    vocabField: 'prompt',
    price: 0.0045,
    unit: 'minute',
  },
  whisper: {
    id: 'openai/whisper-large-v3',
    label: 'Whisper Large V3',
    provider: 'groq',
    vocabField: 'prompt',
    price: 0.111,
    unit: 'hour',
    vocabMaxChars: 896, // Whisper caps the prompt at ~224 tokens
  },
  'whisper-turbo': {
    id: 'openai/whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    provider: 'groq',
    vocabField: 'prompt',
    price: 0.04,
    unit: 'hour',
    vocabMaxChars: 896,
  },
}

const AUDIO_FORMATS = {
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.m4a': 'm4a',
  '.mp4': 'mp4',
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'opus',
  '.webm': 'webm',
  '.aac': 'aac',
}

const SECONDS_PER_UNIT = { second: 1, minute: 60, hour: 3600 }

export function resolveModel(name) {
  const alias = String(name).trim()
  if (MODELS[alias]) return { alias, ...MODELS[alias] }

  const byId = Object.entries(MODELS).find(([, m]) => m.id === alias)
  if (byId) return { alias: byId[0], ...byId[1] }

  if (alias.includes('/')) {
    return {
      alias: alias.replace(/\W+/g, '-'),
      id: alias,
      label: alias,
      provider: null,
      vocabField: 'prompt',
    }
  }
  throw new Error(
    `Unknown model "${alias}". Use one of: ${Object.keys(MODELS).join(', ')}, or a full OpenRouter model ID.`,
  )
}

export function parseVocab(raw) {
  const terms = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  return [...new Set(terms)].join(', ')
}

export function audioFormatFor(filePath) {
  const ext = extname(filePath).toLowerCase()
  const format = AUDIO_FORMATS[ext]
  if (!format) {
    throw new Error(
      `Unsupported audio extension "${ext}". Supported: ${Object.keys(AUDIO_FORMATS).join(', ')}`,
    )
  }
  return format
}

export function estimateCost(model, seconds) {
  const per = SECONDS_PER_UNIT[model.unit]
  if (!per || !Number.isFinite(seconds)) return null
  return (model.price * seconds) / per
}

export function buildRequestBody({ model, audioBase64, format, vocab, language, provider }) {
  const body = {
    model: model.id,
    input_audio: { data: audioBase64, format },
  }
  if (language) body.language = language

  const tag = provider || model.provider
  if (tag) {
    body.provider = { order: [tag], allow_fallbacks: false }
    if (vocab) body.provider.options = { [tag]: { [model.vocabField]: vocab } }
  }
  return body
}

function parseArgs(argv) {
  const args = { models: [], file: null, vocabFile: DEFAULT_VOCAB_FILE, useVocab: true }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }

    if (arg === '--model' || arg === '-m')
      args.models = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (arg === '--file' || arg === '-f') args.file = next()
    else if (arg === '--vocab') args.vocabFile = next()
    else if (arg === '--vocab-field') args.vocabField = next()
    else if (arg === '--no-vocab') args.useVocab = false
    else if (arg === '--provider') args.provider = next()
    else if (arg === '--language' || arg === '-l') args.language = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown flag "${arg}"`)
  }
  return args
}

function usage() {
  console.log(`
stt-transcribe — run an audio file through OpenRouter speech-to-text.

  --model, -m     Comma-separated aliases or full model IDs. Required.
                  Aliases: ${Object.keys(MODELS).join(', ')}
  --file, -f      Path to the .wav / .mp3 / etc to transcribe. Required.
  --vocab         Vocab file name, resolved next to this script.
                  Default: ${DEFAULT_VOCAB_FILE}
  --vocab-field   Override the provider option key the vocab is sent under.
  --no-vocab      Send no vocabulary at all (for A/B testing the lift).
  --provider      Pin a provider tag (groq, deepinfra, together, openai, alibaba).
  --language, -l  ISO-639-1 hint, e.g. en. Omit to auto-detect.
  --out-dir       Where transcripts land. Default: <script dir>/transcripts
  --dry-run       Print the request body (audio truncated) and exit.

Requires OPENROUTER_API_KEY in the environment.
`)
}

function loadVocab(args) {
  if (!args.useVocab) return ''

  const path = resolve(SCRIPT_DIR, args.vocabFile)
  if (!existsSync(path)) {
    console.warn(`No vocab file at ${path}, continuing without one.`)
    return ''
  }
  return parseVocab(readFileSync(path, 'utf8'))
}

function capVocab(model, vocab) {
  if (!model.vocabMaxChars || vocab.length <= model.vocabMaxChars) return vocab

  const clipped = vocab.slice(0, model.vocabMaxChars)
  const lastComma = clipped.lastIndexOf(',')
  const trimmed = (lastComma > 0 ? clipped.slice(0, lastComma) : clipped).trim()
  console.warn(
    `Vocab is ${vocab.length} chars, over the ${model.vocabMaxChars} char limit for ${model.label}. Truncated to ${trimmed.length}.`,
  )
  return trimmed
}

async function transcribe({ model, body, apiKey }) {
  const startedAt = performance.now()
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  const latencyMs = performance.now() - startedAt
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${model.label} failed: HTTP ${response.status}\n${text}`)
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${model.label} returned non-JSON:\n${text.slice(0, 500)}`)
  }
  return { payload, latencyMs }
}

function writeResults({ outDir, audioFile, model, payload, latencyMs, vocab, body }) {
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stem = `${basename(audioFile, extname(audioFile))}__${model.alias}__${stamp}`

  const transcriptPath = join(outDir, `${stem}.txt`)
  const metaPath = join(outDir, `${stem}.json`)

  writeFileSync(transcriptPath, `${payload.text ?? ''}\n`)
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        model: model.id,
        label: model.label,
        provider: body.provider?.order?.[0] ?? null,
        audioFile: resolve(audioFile),
        language: body.language ?? 'auto',
        vocabSent: vocab || null,
        vocabField: vocab ? model.vocabField : null,
        latencyMs: Math.round(latencyMs),
        usage: payload.usage ?? null,
        estimatedCost: estimateCost(model, payload.usage?.seconds),
        text: payload.text ?? '',
      },
      null,
      2,
    )}\n`,
  )
  return { transcriptPath, metaPath }
}

function money(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return `$${value.toFixed(6)}`
}

function report({ model, payload, latencyMs, paths, body }) {
  const usage = payload.usage ?? {}
  const seconds = usage.seconds
  const estimated = estimateCost(model, seconds)
  const rtf = Number.isFinite(seconds) && latencyMs > 0 ? seconds / (latencyMs / 1000) : null

  console.log(`\n=== ${model.label}  (${model.id})`)
  console.log(`    provider     ${body.provider?.order?.[0] ?? 'auto'}`)
  console.log(`    audio        ${Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : 'unknown'}`)
  console.log(
    `    latency      ${(latencyMs / 1000).toFixed(2)}s roundtrip${rtf ? `  (${rtf.toFixed(1)}x realtime)` : ''}`,
  )
  console.log(
    `    cost         ${money(usage.cost)} billed${estimated != null ? `, ${money(estimated)} expected` : ''}`,
  )
  if (usage.input_tokens != null) {
    console.log(`    tokens       ${usage.input_tokens} in / ${usage.output_tokens} out`)
  }
  console.log(`    saved        ${paths.transcriptPath}`)
  console.log(`\n${payload.text ?? '(empty transcript)'}\n`)

  return {
    label: model.label,
    latencyMs,
    cost: usage.cost,
    estimated,
    seconds,
    chars: (payload.text ?? '').length,
  }
}

function summarise(rows) {
  if (rows.length < 2) return

  console.log('\n--- comparison')
  console.log('model                       latency      billed     expected   chars')
  for (const row of rows) {
    console.log(
      [
        row.label.padEnd(26),
        `${(row.latencyMs / 1000).toFixed(2)}s`.padStart(8),
        money(row.cost).padStart(12),
        money(row.estimated).padStart(11),
        String(row.chars).padStart(7),
      ].join(' '),
    )
  }
  const total = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  console.log(`total billed: ${money(total)}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.models.length && !args.file)) {
    usage()
    return
  }
  if (!args.models.length) throw new Error('--model is required')
  if (!args.file) throw new Error('--file is required')
  if (!existsSync(args.file)) throw new Error(`Audio file not found: ${args.file}`)

  const models = args.models.map(resolveModel)

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey && !args.dryRun) throw new Error('OPENROUTER_API_KEY is not set')

  const format = audioFormatFor(args.file)
  const bytes = statSync(args.file).size
  const audioBase64 = readFileSync(args.file).toString('base64')
  const vocab = loadVocab(args)
  const outDir = args.outDir ? resolve(args.outDir) : join(SCRIPT_DIR, 'transcripts')

  console.log(`file    ${resolve(args.file)}  (${(bytes / 1024 / 1024).toFixed(2)} MB ${format})`)
  console.log(`vocab   ${vocab ? `${vocab.length} chars from ${args.vocabFile}` : 'none'}`)

  const rows = []
  for (const model of models) {
    if (args.vocabField) model.vocabField = args.vocabField

    const body = buildRequestBody({
      model,
      audioBase64,
      format,
      vocab: capVocab(model, vocab),
      language: args.language,
      provider: args.provider,
    })

    if (args.dryRun) {
      console.log(`\n=== ${model.label} request`)
      console.log(
        JSON.stringify(
          { ...body, input_audio: { ...body.input_audio, data: `<${bytes} bytes base64>` } },
          null,
          2,
        ),
      )
      continue
    }

    try {
      const { payload, latencyMs } = await transcribe({ model, body, apiKey })
      const paths = writeResults({
        outDir,
        audioFile: args.file,
        model,
        payload,
        latencyMs,
        vocab,
        body,
      })
      rows.push(report({ model, payload, latencyMs, paths, body }))
    } catch (error) {
      console.error(`\n=== ${model.label} ERROR\n${error.message}\n`)
    }
  }
  summarise(rows)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
