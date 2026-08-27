#!/usr/bin/env node
/**
 * adjuster-inject-test-job.mjs — drop a locally downloaded Dograh transcript +
 * recording into the Adjuster Jobs sheet as though the dograh_notetaker
 * webhook had fired for a real call.
 *
 * Zero dependencies. Node 20+ (uses built-in fetch). Not wired into the app;
 * run it directly, it does not import anything from this repo.
 *
 * Posts to the Adjuster Apps Script web app's `manual_recording_inject` event
 * (see apps/adjuster/src/webhook.js). The audio travels as a base64 field in
 * the JSON body, not a fetchable URL — there is nothing to fetch, the file
 * only exists on disk — so the webhook decodes it straight into Drive. The
 * resulting row has source=dograh and status=pending, so the next runner tick
 * picks it up and runs it through the same matching/transcription/extraction
 * pipeline a live call gets.
 *
 *   export ADJUSTER_WEBHOOK_URL=https://script.google.com/macros/s/XXXX/exec
 *   export ADJUSTER_WEBHOOK_SECRET=...
 *   node scripts/adjuster-inject-test-job.mjs \
 *     --transcript ./call-transcript.txt \
 *     --audio ./call-recording.wav \
 *     --call-time 2026-08-26T18:04:00Z
 *
 * --duration is read from the WAV file's own header when the audio is WAV,
 * so it's normally not needed. Pass it explicitly for other formats (mp3,
 * m4a, ...) or to override.
 *
 * Both values are already set as Apps Script Script Properties for the live
 * deployment (WEBHOOK_SECRET) and the Apps Script project's web app URL
 * (Deploy > Manage deployments) — pull them from there, not from anywhere
 * this repo tracks in git (see docs/adr/006-adjuster-apps-script-runtime.md).
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }

    if (arg === '--transcript' || arg === '-t') args.transcript = next()
    else if (arg === '--audio' || arg === '-a') args.audio = next()
    else if (arg === '--capture-id') args.captureId = next()
    else if (arg === '--call-time') args.callTime = next()
    else if (arg === '--duration') args.duration = next()
    else if (arg === '--disposition') args.disposition = next()
    else if (arg === '--webhook-url') args.webhookUrl = next()
    else if (arg === '--secret') args.secret = next()
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown flag "${arg}"`)
  }
  return args
}

function usage() {
  console.log(`
adjuster-inject-test-job — post a local transcript + recording to the
Adjuster webhook as if a Dograh call had just finished.

  --transcript, -t  Path to a .txt file with the call transcript. Required.
  --audio, -a       Path to the recording file (.wav, .mp3, ...). Required.
  --capture-id      capture_id for the Jobs row. Default: manual-<timestamp>.
  --call-time       ISO 8601 call start time. Default: now.
  --duration        Call duration in seconds. Auto-read from a WAV file's
                    header when the audio is WAV; otherwise omitted.
  --disposition     Free-text call_disposition value. Default: omitted.
  --webhook-url     Overrides ADJUSTER_WEBHOOK_URL.
  --secret          Overrides ADJUSTER_WEBHOOK_SECRET.

Requires ADJUSTER_WEBHOOK_URL and ADJUSTER_WEBHOOK_SECRET in the environment
(or the --webhook-url/--secret flags) — pull both from the Adjuster Apps
Script project, not from this repo.
`)
}

// Matches guessAudioExtension() in apps/adjuster/src/webhook.js: only the
// extension is sent, the webhook doesn't care what codec is behind it.
function audioExtensionFor(filePath) {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '')
  return ext || 'wav'
}

// duration_sec isn't load-bearing for the pipeline (transcription chunking
// re-probes the real audio bytes independently — see probeWav() in
// apps/adjuster/src/transcription.js) but docgen.js prints it in the report
// header, and it's already sitting in the WAV file's own header, so there's
// no reason to make the caller type it in by hand. Walks the RIFF chunk list
// rather than assuming a fixed 44-byte header, mirroring probeWav(). Returns
// null for anything that isn't PCM WAV (mp3, m4a, ...) or has no fmt/data
// chunk, and the caller falls back to --duration or leaves it blank.
function wavDurationSeconds(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null

  let byteRate = 0
  let dataSize = 0
  let offset = 12

  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (tag === 'fmt ' && size >= 16) {
      byteRate = buffer.readUInt32LE(body + 8)
    } else if (tag === 'data') {
      dataSize = Math.min(size, buffer.length - body)
      break
    }

    offset = body + size + (size % 2)
  }

  return byteRate ? dataSize / byteRate : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  if (!args.transcript) throw new Error('--transcript is required')
  if (!args.audio) throw new Error('--audio is required')
  if (!existsSync(args.transcript)) throw new Error(`Transcript file not found: ${args.transcript}`)
  if (!existsSync(args.audio)) throw new Error(`Audio file not found: ${args.audio}`)

  const webhookUrl = args.webhookUrl || process.env.ADJUSTER_WEBHOOK_URL
  const secret = args.secret || process.env.ADJUSTER_WEBHOOK_SECRET
  if (!webhookUrl) throw new Error('ADJUSTER_WEBHOOK_URL is not set (or pass --webhook-url)')
  if (!secret) throw new Error('ADJUSTER_WEBHOOK_SECRET is not set (or pass --secret)')

  const captureId = args.captureId || `manual-${Date.now()}`
  const transcript = readFileSync(args.transcript, 'utf8')
  const audioBuffer = readFileSync(args.audio)
  const audioExtension = audioExtensionFor(args.audio)

  console.log(`transcript  ${resolve(args.transcript)}  (${transcript.length} chars)`)
  console.log(
    `audio       ${resolve(args.audio)}  (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`,
  )
  console.log(`capture_id  ${captureId}`)

  let durationSec = args.duration ? Number(args.duration) : null
  if (!durationSec && audioExtension === 'wav') {
    const detected = wavDurationSeconds(audioBuffer)
    if (detected) {
      durationSec = Math.round(detected)
      console.log(`duration    ${durationSec}s (read from WAV header)`)
    }
  }

  const body = {
    capture_id: captureId,
    transcript,
    audio_base64: audioBuffer.toString('base64'),
    audio_extension: audioExtension,
    call_time: args.callTime || new Date().toISOString(),
  }
  if (durationSec) body.duration_sec = durationSec
  if (args.disposition) body.call_disposition = args.disposition

  const url = new URL(webhookUrl)
  url.searchParams.set('t', secret)
  url.searchParams.set('event', 'manual_recording_inject')

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  })
  const text = await response.text()

  if (!response.ok) throw new Error(`Webhook returned ${response.status}: ${text}`)

  console.log(`response    ${response.status} ${text}`)
  console.log(`\nDone. capture_id=${captureId} should now be a 'pending' row in the Jobs tab.`)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
