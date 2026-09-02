// The runtime-agnostic half of transcription: keyterms, request building, WAV
// probing and slicing, response parsing, source precedence, and the fan-out
// itself. Its Drive-and-manifest half stays in apps/adjuster/src/transcription.js
// as an adapter. See docs/specs/021 and docs/adr/009.
//
// Runtime notes: core is synchronous by construction, because Apps Script has
// no Promise and no async. "In parallel" is therefore deps.fetchAll, which the
// Apps Script adapter maps to UrlFetchApp.fetchAll and a Node host maps to
// whatever it likes. scripts/stt-transcribe.mjs cannot be imported — the model
// table and OpenRouter request shape below are ported from it by hand, and that
// script stays as the local A/B harness.

var ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
var OPENROUTER_TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'

// Mirrors the MODELS table in scripts/stt-transcribe.mjs so swapping a model is
// a one-line edit. ElevenLabs is a direct-vendor call rather than an OpenRouter
// one because diarization and keyterm biasing are ElevenLabs-native parameters
// with no OpenRouter passthrough — the documented exception in docs/adr/007.
var TRANSCRIPTION_MODELS = {
  elevenlabs: { id: 'scribe_v2', label: 'ElevenLabs Scribe v2', vendor: 'elevenlabs' },
  qwen: {
    id: 'qwen/qwen3-asr-flash-2026-02-10',
    label: 'Qwen3 ASR Flash',
    vendor: 'openrouter',
    provider: 'alibaba',
  },
}

// One ordering governs every degraded path: which source wins a disagreement
// inside the merge, and which source becomes the master when there is no usable
// merge. The job's own voice-platform transcript is last on wording
// (single-pass, real-time, lossy codec) and first on turn structure (it is the
// only source that knows when the agent spoke). Defined once, consumed by
// both the merge prompt and the fallback. The literal third slot below
// ('dograh') is this array's default/shape reference, used whenever a caller
// doesn't pass a per-job precedence — the real per-job precedence is built
// inline in runTranscriptionPass() as ['elevenlabs', 'qwen', voiceSource].
var SOURCE_PRECEDENCE = ['elevenlabs', 'qwen', 'dograh']

// Voice platforms this pass can source a streaming transcript from. A job
// whose source isn't in this list (Telnyx, or anything future) skips stage A
// entirely and rides the floor: whatever transcript already lives on the job.
var VOICE_PLATFORM_SOURCES = ['dograh', 'retell']

// ElevenLabs' documented keyterm rules. MAX_CHARS is 49 because the limit is
// "less than 50 characters", not "at most 50" — a term of exactly 50 is refused.
var KEYTERM_MAX_TERMS = 1000
var KEYTERM_MAX_CHARS = 49
var KEYTERM_MAX_WORDS = 5
var KEYTERM_BANNED_CHARS = /[<>{}[\]\\]/g
var CLAIM_KEYTERM_FIELDS = ['insured_last_name', 'address_line1', 'city', 'carrier', 'claim_number']

// Alibaba caps qwen3-asr-flash at 10 MB and 5 minutes per request and enforces
// it upstream, where OpenRouter masks the rejection as an opaque "Provider
// returned 400" with nothing to debug from. So the split happens before the
// send: audio past either cap is cut into slices that each fit, and the slice
// transcripts are concatenated in order. ElevenLabs is unaffected — it takes
// the whole blob as multipart and documents a 5 GB ceiling.
var QWEN_MAX_SECONDS = 300
var QWEN_MAX_BYTES = 10 * 1024 * 1024
var WAV_HEADER_BYTES = 44
var WAV_PCM_FORMAT = 1

var TRANSCRIPTION_RETRY_BACKOFF_MS = 5000

// ---------------------------------------------------------------------------
// Keyterms
// ---------------------------------------------------------------------------

// Highest-value terms first, because the cap truncates the tail: the claim's own
// proper nouns are what a real-time model over a cell connection gets wrong and
// what the report most needs right, then the adjuster's name, then the trade
// glossary the extraction prompt already gets.
function buildKeyterms(claim, glossary, adjusterName) {
  var terms = []

  CLAIM_KEYTERM_FIELDS.forEach(function (field) {
    if (claim && claim[field]) terms.push(String(claim[field]))
  })

  if (adjusterName) terms.push(String(adjusterName))
  ;(glossary || []).forEach(function (entry) {
    if (entry && entry.term) terms.push(String(entry.term))
  })

  var seen = {}
  var capped = []

  for (var i = 0; i < terms.length && capped.length < KEYTERM_MAX_TERMS; i++) {
    var term = sanitizeKeyterm(terms[i])
    if (!term) continue

    var key = term.toLowerCase()
    if (seen[key]) continue

    seen[key] = true
    capped.push(term)
  }

  return capped
}

// ElevenLabs rejects the whole request if any single term breaks its rules, so
// every term is made to fit rather than left to fail the batch: banned
// characters out, at most 5 words, under 50 characters.
function sanitizeKeyterm(value) {
  var cleaned = String(value || '')
    .replace(KEYTERM_BANNED_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return ''

  var words = cleaned.split(' ')
  if (words.length > KEYTERM_MAX_WORDS) cleaned = words.slice(0, KEYTERM_MAX_WORDS).join(' ')

  return cleaned.slice(0, KEYTERM_MAX_CHARS).trim()
}

// ---------------------------------------------------------------------------
// Request building
//
// `audio` is a plain { bytes, name, contentType } record rather than a Drive
// Blob — the adapter unwraps the blob on the way in, so nothing here knows what
// a Blob is.
// ---------------------------------------------------------------------------

// keyterms is an array field: ElevenLabs wants one `keyterms` part per term.
// UrlFetchApp's payload object cannot express a repeated form field, and the
// JSON array this used to send in a single part is exactly what produced
// "All keywords must be less than 50 characters" — the server measured the
// whole serialized array against its per-term limit. Hence the hand-built body.
function buildElevenLabsRequest(audio, keyterms, apiKey, deps) {
  var boundary = 'adjusterform' + Date.now()
  var fields = [
    { name: 'model_id', value: TRANSCRIPTION_MODELS.elevenlabs.id },
    { name: 'language_code', value: 'en' },
    { name: 'diarize', value: 'true' },
    { name: 'num_speakers', value: '2' },
    { name: 'timestamps_granularity', value: 'word' },
  ]

  ;(keyterms || []).forEach(function (term) {
    fields.push({ name: 'keyterms', value: term })
  })

  return {
    url: ELEVENLABS_URL,
    method: 'post',
    contentType: 'multipart/form-data; boundary=' + boundary,
    headers: { 'xi-api-key': apiKey },
    payload: buildMultipartBody(boundary, fields, 'file', audio, deps),
  }
}

// deps.stringToBytes rather than a hand-rolled UTF-8 encoder: a keyterm is a
// proper noun off a real claim and may be non-ASCII, and getting those bytes
// subtly wrong would fail the whole ElevenLabs request for reasons that read as
// a vendor problem.
function buildMultipartBody(boundary, fields, fileFieldName, file, deps) {
  var head = []

  fields.forEach(function (field) {
    head.push('--' + boundary)
    head.push('Content-Disposition: form-data; name="' + field.name + '"')
    head.push('')
    head.push(field.value)
  })

  head.push('--' + boundary)
  head.push(
    'Content-Disposition: form-data; name="' +
      fileFieldName +
      '"; filename="' +
      (file.name || 'audio.wav') +
      '"',
  )
  head.push('Content-Type: ' + (file.contentType || 'application/octet-stream'))
  head.push('')
  head.push('')

  return []
    .concat(coreStringToBytes(deps, head.join('\r\n')))
    .concat(file.bytes)
    .concat(coreStringToBytes(deps, '\r\n--' + boundary + '--\r\n'))
}

function buildQwenRequest(audioBase64, format, apiKey) {
  var model = TRANSCRIPTION_MODELS.qwen

  return {
    url: OPENROUTER_TRANSCRIPTION_URL,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model.id,
      input_audio: { data: audioBase64, format: format || 'wav' },
      language: 'en',
      // Alibaba is the only provider serving this model, and OpenRouter's
      // endpoints API declares no passthrough parameters for it, so there is
      // no route for keyterm biasing here and nothing to fall back to. Biasing
      // is an ElevenLabs-only capability in this pipeline.
      provider: { order: [model.provider], allow_fallbacks: false },
    }),
  }
}

// ---------------------------------------------------------------------------
// WAV probing and slicing
//
// There is no ffmpeg in Apps Script, so a slice has to be cut out of the PCM
// payload by hand. That only works for uncompressed WAV: a compressed container
// cannot be cut on a byte boundary, and probeWav returns null for one so the
// caller never tries.
// ---------------------------------------------------------------------------

// Blob.getBytes() hands back Java's signed bytes, so every read masks to 0-255.
function readByte(bytes, offset) {
  return bytes[offset] & 0xff
}

function readTag(bytes, offset) {
  var tag = ''
  for (var i = 0; i < 4; i++) tag += String.fromCharCode(readByte(bytes, offset + i))
  return tag
}

function readUint16(bytes, offset) {
  return readByte(bytes, offset) + readByte(bytes, offset + 1) * 256
}

// Multiplication rather than bit shifts: a 32-bit size with the high bit set
// would come back negative through <<.
function readUint32(bytes, offset) {
  return (
    readByte(bytes, offset) +
    readByte(bytes, offset + 1) * 256 +
    readByte(bytes, offset + 2) * 65536 +
    readByte(bytes, offset + 3) * 16777216
  )
}

// Walks the RIFF chunk list rather than assuming a canonical 44-byte header:
// real recorders emit LIST/fact chunks ahead of data, and a fixed offset would
// read the wrong bytes as audio. Returns null for anything not PCM WAV.
function probeWav(bytes) {
  if (!bytes || bytes.length < WAV_HEADER_BYTES) return null
  if (readTag(bytes, 0) !== 'RIFF' || readTag(bytes, 8) !== 'WAVE') return null

  var fmt = null
  var dataOffset = 0
  var dataSize = 0
  var offset = 12

  while (offset + 8 <= bytes.length) {
    var tag = readTag(bytes, offset)
    var size = readUint32(bytes, offset + 4)
    var body = offset + 8

    if (tag === 'fmt ' && size >= 16) {
      fmt = {
        format: readUint16(bytes, body),
        channels: readUint16(bytes, body + 2),
        sampleRate: readUint32(bytes, body + 4),
        byteRate: readUint32(bytes, body + 8),
        blockAlign: readUint16(bytes, body + 12),
        bitsPerSample: readUint16(bytes, body + 14),
      }
    } else if (tag === 'data') {
      dataOffset = body
      dataSize = Math.min(size, bytes.length - body)
      break
    }

    offset = body + size + (size % 2)
  }

  if (!fmt || fmt.format !== WAV_PCM_FORMAT || !fmt.byteRate || !dataOffset) return null

  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    byteRate: fmt.byteRate,
    blockAlign: fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8,
    bitsPerSample: fmt.bitsPerSample,
    dataOffset: dataOffset,
    dataSize: dataSize,
    seconds: dataSize / fmt.byteRate,
  }
}

// Cuts [startSec, endSec) out of the payload and gives it a fresh canonical
// header, so each slice is a standalone WAV. Offsets snap down to a block
// boundary: a cut through the middle of a sample shifts every sample after it
// and turns the rest of the slice into noise.
function sliceWav(bytes, probe, startSec, endSec) {
  var align = probe.blockAlign || 1
  var from = snapToBlock(Math.floor(startSec * probe.byteRate), align)
  var to = snapToBlock(Math.ceil(endSec * probe.byteRate), align)

  if (to > probe.dataSize) to = snapToBlock(probe.dataSize, align)
  if (from > to) from = to

  var pcm = bytes.slice(probe.dataOffset + from, probe.dataOffset + to)
  return buildWavHeader(probe, pcm.length).concat(pcm)
}

function snapToBlock(value, align) {
  return Math.max(0, value - (value % align))
}

function buildWavHeader(probe, pcmLength) {
  return []
    .concat(tagBytes('RIFF'), uint32Bytes(36 + pcmLength), tagBytes('WAVE'))
    .concat(tagBytes('fmt '), uint32Bytes(16), uint16Bytes(WAV_PCM_FORMAT))
    .concat(uint16Bytes(probe.channels), uint32Bytes(probe.sampleRate))
    .concat(uint32Bytes(probe.byteRate), uint16Bytes(probe.blockAlign))
    .concat(uint16Bytes(probe.bitsPerSample))
    .concat(tagBytes('data'), uint32Bytes(pcmLength))
}

function tagBytes(tag) {
  var out = []
  for (var i = 0; i < tag.length; i++) out.push(tag.charCodeAt(i))
  return out
}

function uint16Bytes(value) {
  return [value & 0xff, (value >> 8) & 0xff]
}

function uint32Bytes(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
}

// The tighter of Alibaba's two caps wins: 300 seconds, or however many whole
// seconds fit in 10 MB at this file's byte rate once the header is paid for.
function qwenChunkSeconds(probe) {
  var byBytes = Math.floor((QWEN_MAX_BYTES - WAV_HEADER_BYTES) / probe.byteRate)
  return Math.max(0, Math.min(QWEN_MAX_SECONDS, byBytes))
}

// Returns the slices to send, or an empty list when the audio cannot be made to
// fit — unsplittable because it is not PCM WAV, and over a cap.
function splitForQwen(bytes, probe) {
  var fitsBytes = bytes.length <= QWEN_MAX_BYTES

  if (!probe) return fitsBytes ? [bytes] : []
  if (fitsBytes && probe.seconds <= QWEN_MAX_SECONDS) return [bytes]

  var span = qwenChunkSeconds(probe)
  if (span <= 0) return []

  var chunks = []
  for (var start = 0; start < probe.seconds; start += span) {
    chunks.push(sliceWav(bytes, probe, start, Math.min(start + span, probe.seconds)))
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function isRetryableStatus(status) {
  return status === 429 || status >= 500
}

// `response` is deps.fetch's { status, body } record, or null when the host
// could not complete the round trip at all.
function resolveSourceResponse(label, response) {
  if (!response) return { source: label, text: '', ok: false, status: 0, error: 'no_response' }

  var status = response.status
  var bodyText = String(response.body || '')

  // 2000 chars, matching describeError()'s stack cap: an ElevenLabs 400 carries
  // its reason in a `detail` array that routinely runs past 500.
  if (status !== 200) {
    return { source: label, text: '', ok: false, status: status, error: bodyText.slice(0, 2000) }
  }

  try {
    var parsed =
      label === 'elevenlabs' ? parseElevenLabsResponse(bodyText) : parseQwenResponse(bodyText)
    return Object.assign(
      { source: label, ok: true, status: status, bytes: bodyText.length },
      parsed,
    )
  } catch (err) {
    return { source: label, text: '', ok: false, status: status, error: String(err) }
  }
}

function parseElevenLabsResponse(bodyText) {
  var body = JSON.parse(bodyText)
  var words = body.words || []

  return {
    text: String(body.text || ''),
    words: words,
    turns: renderDiarizedTurns(words),
    duration_sec: body.audio_duration_secs,
    language_code: body.language_code,
  }
}

// Diarization is a hint for splitting the batch text into turns for the merge
// prompt, not the source of speaker identity — the voice platform's turn
// structure is the skeleton, so nothing downstream reads these speaker IDs.
function renderDiarizedTurns(words) {
  var turns = []
  var current = null

  ;(words || []).forEach(function (word) {
    var text = String(word.text || '')
    if (!text) return

    var speaker = String(word.speaker_id || 'speaker_0')
    if (!current || current.speaker !== speaker) {
      current = { speaker: speaker, text: '' }
      turns.push(current)
    }

    current.text += text
  })

  return turns
    .map(function (turn) {
      return { speaker: turn.speaker, text: turn.text.replace(/\s+/g, ' ').trim() }
    })
    .filter(function (turn) {
      return turn.text
    })
}

function parseQwenResponse(bodyText) {
  var body = JSON.parse(bodyText)
  return { text: String(body.text || ''), usage: body.usage || {} }
}

// A split source collapses back into the single result the rest of the pass
// expects. One failed slice fails the whole source: a transcript with a silent
// gap in the middle is worse than none, because the merge would read the gap as
// the sources agreeing rather than as missing audio.
function combineChunks(source, parts) {
  if (parts.length === 1) return parts[0]

  var failed = null
  var texts = []

  parts.forEach(function (part) {
    if (!part.ok && !failed) failed = part
    texts.push(String(part.text || '').trim())
  })

  if (failed) {
    return {
      source: source,
      text: '',
      ok: false,
      status: failed.status,
      error: failed.error,
    }
  }

  return {
    source: source,
    text: texts.filter(Boolean).join(' '),
    ok: true,
    status: 200,
  }
}

// ---------------------------------------------------------------------------
// core.transcribe
// ---------------------------------------------------------------------------

// Issues both ASR calls through one deps.fetchAll. Failure is per-source and
// never fatal: each source independently yields either text or empty, and the
// caller decides what to do with however many came back.
//
//   input: { captureId, audio: { bytes, name, contentType }, format, keyterms,
//            config: { elevenLabsApiKey, openRouterApiKey }, deps }
//   -> { sources: { [name]: { text, words?, turns? } }, attempts, fetch_mode }
function coreTranscribe(input) {
  var deps = input.deps
  var config = input.config || {}
  var captureId = input.captureId || ''
  var keyterms = input.keyterms || []
  var audio = input.audio || {}
  // One entry per HTTP request. Qwen contributes several when the audio has to
  // be split, so this is a flat plan rather than one request per source.
  var plan = []

  // A missing key is a configuration state, not a failure: the default mode on
  // first deploy is shadow, and a deploy that has not set ELEVENLABS_API_KEY yet
  if (config.elevenLabsApiKey) {
    plan.push({
      source: 'elevenlabs',
      request: buildElevenLabsRequest(audio, keyterms, config.elevenLabsApiKey, deps),
    })
  } else {
    coreLogEvent(deps, 'transcription.source_unconfigured', {
      capture_id: captureId,
      source: 'elevenlabs',
    })
  }

  if (config.openRouterApiKey) {
    planQwenRequests(plan, input, captureId)
  } else {
    coreLogEvent(deps, 'transcription.source_unconfigured', {
      capture_id: captureId,
      source: 'qwen',
    })
  }

  if (!plan.length) return { sources: {}, attempts: [], fetch_mode: 'none' }

  var startedAt = Date.now()
  var batch = coreFetchAll(
    deps,
    plan.map(function (entry) {
      return entry.request
    }),
  )
  // fetchAll issues every request concurrently, so there is one wall clock for
  // the batch rather than a latency per source. The sequential fallback shares
  // it too; fetch_mode in the manifest says which of the two you are reading.
  var latencyMs = Date.now() - startedAt

  var parts = {}
  var attempts = []

  plan.forEach(function (entry, index) {
    var result = resolveSourceResponse(entry.source, batch.responses[index])
    attempts.push({ source: entry.source, ok: result.ok, status: result.status, retried: false })

    if (!result.ok && isRetryableStatus(result.status)) {
      coreLogEvent(deps, 'transcription.retry', {
        capture_id: captureId,
        source: entry.source,
        status: result.status,
      })
      coreSleep(deps, TRANSCRIPTION_RETRY_BACKOFF_MS)
      result = resolveSourceResponse(entry.source, coreTryFetch(deps, entry.request))
      attempts.push({ source: entry.source, ok: result.ok, status: result.status, retried: true })
    }

    if (!parts[entry.source]) parts[entry.source] = []
    parts[entry.source].push(result)
  })

  var sources = {}

  Object.keys(parts).forEach(function (source) {
    var result = combineChunks(source, parts[source])
    result.latency_ms = latencyMs
    sources[source] = result

    coreLogEvent(deps, 'transcription.source_finished', {
      capture_id: captureId,
      source: source,
      ok: result.ok,
      status: result.status,
      chars: String(result.text || '').length,
      chunks: parts[source].length,
      latency_ms: latencyMs,
      // The vendor's own words for why it refused. Without this a 400 logs as
      // ok:false with no reason attached, and the body resolveSourceResponse
      // captured dies here. A 4xx is not retryable, so this line is the only
      // record of the failure the call ever produces.
      error: result.ok ? '' : String(result.error || ''),
    })
  })

  return { sources: sources, attempts: attempts, fetch_mode: batch.mode }
}

// A transport error on the retry drops that source rather than failing the
// whole pass — the same contract the batch call has.
function coreTryFetch(deps, request) {
  try {
    return requireCoreFetch(deps)(request)
  } catch (err) {
    coreLogEvent(deps, 'transcription.fetch_failed', { url: request.url, error: String(err) })
    return null
  }
}

// Qwen's slice of the plan. Everything is base64-encoded up front so a failure
// to encode drops the source cleanly instead of sending a transcript with a
// hole where one slice should have been.
function planQwenRequests(plan, input, captureId) {
  var deps = input.deps
  var bytes = (input.audio || {}).bytes
  var probe = probeWav(bytes)
  var chunks = splitForQwen(bytes, probe)

  if (!chunks.length) {
    coreLogEvent(deps, 'transcription.audio_too_large', {
      capture_id: captureId,
      bytes: bytes.length,
      seconds: probe ? probe.seconds : '',
      max_bytes: QWEN_MAX_BYTES,
      max_seconds: QWEN_MAX_SECONDS,
      splittable: Boolean(probe),
    })
    return
  }

  var encoded = []

  for (var i = 0; i < chunks.length; i++) {
    var base64 = encodeAudioBase64(chunks[i], captureId, deps)
    if (!base64) return
    encoded.push(base64)
  }

  if (encoded.length > 1) {
    coreLogEvent(deps, 'transcription.audio_split', {
      capture_id: captureId,
      chunks: encoded.length,
      seconds: probe.seconds,
      chunk_seconds: qwenChunkSeconds(probe),
    })
  }

  encoded.forEach(function (base64) {
    plan.push({
      source: 'qwen',
      // A slice is always WAV whatever the original container was, because
      // sliceWav writes its own header.
      request: buildQwenRequest(
        base64,
        probe ? 'wav' : input.format,
        input.config.openRouterApiKey,
      ),
    })
  })
}

function encodeAudioBase64(bytes, captureId, deps) {
  try {
    return coreBase64Encode(deps, bytes)
  } catch (err) {
    coreLogEvent(deps, 'transcription.audio_encode_failed', {
      capture_id: captureId,
      error: String(err),
    })
    return ''
  }
}

// ---------------------------------------------------------------------------
// Source precedence
// ---------------------------------------------------------------------------

// Every "fall back" in spec 012 resolves through here, so the fallback order and
// the merge prompt's disagreement order can never drift apart.
function selectFallbackTranscript(sources, precedence) {
  var order = precedence || SOURCE_PRECEDENCE

  for (var i = 0; i < order.length; i++) {
    var name = order[i]
    var entry = (sources || {})[name]
    var text = entry ? String(entry.text || '') : ''
    if (text.trim()) return { source: name, text: text }
  }

  return { source: '', text: '' }
}

function availableSources(sources, precedence) {
  return (precedence || SOURCE_PRECEDENCE).filter(function (name) {
    var entry = (sources || {})[name]
    return entry && String(entry.text || '').trim()
  })
}

function describeSourcesForManifest(sources, precedence) {
  return (precedence || SOURCE_PRECEDENCE).map(function (name) {
    var entry = sources[name] || {}
    return {
      source: name,
      chars: String(entry.text || '').length,
      ok: entry.ok !== false,
      status: entry.status,
      latency_ms: entry.latency_ms,
      error: entry.error || '',
    }
  })
}

// ---------------------------------------------------------------------------
// Merge decision
// ---------------------------------------------------------------------------

// Three sources merge; two merge and log the loss; one skips the merge entirely
// (the master would just be that source restated by a model, which is exactly
// what the verbatim constraint exists to prevent). Zero cannot happen — the
// job's own voice-platform transcript is already on the job before stage A
// runs.
//
// Deliberately does not catch. The caller wraps both this and its own config
// assembly in one try, because a missing script property and a failed merge
// call degrade the run the same way and are logged as the same event.
function coreMergeSources(input) {
  var deps = input.deps
  var config = input.config || {}
  var sources = input.sources
  var order = input.precedence || SOURCE_PRECEDENCE
  var available = input.available || availableSources(sources, order)

  if (available.length < 2) {
    coreLogEvent(deps, 'transcription.single_source', {
      capture_id: input.captureId,
      source: available[0] || '',
    })
    return null
  }

  if (available.length === 2) {
    coreLogEvent(deps, 'transcription.degraded', {
      capture_id: input.captureId,
      available: available.join(','),
      lost: order
        .filter(function (name) {
          return available.indexOf(name) === -1
        })
        .join(','),
    })
  }

  return buildGatedMasterTranscript({
    apiKey: config.apiKey,
    model: config.model,
    fallbacks: config.fallbacks || [],
    deps: deps,
    captureId: input.captureId,
    sources: sources,
    claim: input.claim,
    glossary: input.glossary,
    adjusterName: config.adjusterName,
    precedence: order,
  })
}
