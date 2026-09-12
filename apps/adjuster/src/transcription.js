// Batch transcription layer for voice-platform calls (Dograh, Retell — see
// VOICE_PLATFORM_SOURCES) — see docs/specs/012, docs/specs/016, and
// docs/adr/007. A call platform's own transcript is a real-time stream over a
// mobile codec: it hears each phrase once, live, and it is the weakest link in
// the pipeline. This module re-reads the saved recording with two independent
// high-accuracy batch models and hands all three readings to the merge step in
// llm/masterTranscript.js.
//
// Runtime notes (Apps Script, not Node): there is no Promise and no async, so
// "in parallel" is UrlFetchApp.fetchAll(requests) — but only for the Qwen
// slices; see transcribeInParallel for why ElevenLabs is sent on its own.
// scripts/stt-transcribe.mjs
// cannot be imported — the model table and OpenRouter request shape below are
// ported from it by hand, and that script stays as the local A/B harness.

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

// ---------------------------------------------------------------------------
// Adjuster-only projection — see docs/specs/022 and docs/adr/009.
//
// Matching has no notion of who spoke: it indexOfs claim identity values into
// one flat string, so an agent's read-back suggestion ("Are you calling about
// the property on Maple Street for RAY?") scores exactly like the adjuster
// having said it himself. adjusterTurnsOf() strips every recognized agent line
// before the transcript ever reaches matcher.js or llmMatcher.js, so a
// suggestion the adjuster rejected can never become evidence for it.
//
// Three label vocabularies exist across the pipeline and are recognized by the
// leading token of each line, case-sensitively so they never collide:
//   - Retell's own call.transcript ('Agent:' / 'User:')
//   - The master transcript this module's merge produces ('agent:' / 'adjuster:')
//   - Dograh's Notetaker export, via stitchAIGatherMessages() in util.js ('Q:' / 'A:')
var TRANSCRIPT_LABEL_VOCABULARIES = [
  { name: 'retell', agent: /^Agent:\s*/, adjuster: /^User:\s*/ },
  { name: 'master', agent: /^agent:\s*/, adjuster: /^adjuster:\s*/ },
  { name: 'dograh-notetaker', agent: /^Q:\s*/, adjuster: /^A:\s*/ },
]

// Returns the name of the recognized label vocabulary, or '' when the text
// carries none — a monologue with no agent turns to remove (a manual test
// injection, a raw ElevenLabs/Qwen fallback with no speaker structure at all).
function detectLabelVocabulary(text) {
  var lines = String(text || '').split('\n')

  for (var i = 0; i < TRANSCRIPT_LABEL_VOCABULARIES.length; i++) {
    var vocab = TRANSCRIPT_LABEL_VOCABULARIES[i]
    var recognized = lines.some(function (line) {
      return vocab.agent.test(line) || vocab.adjuster.test(line)
    })
    if (recognized) return vocab.name
  }

  return ''
}

// The projection never returns empty for a non-empty input: a transcript whose
// vocabulary isn't recognized is passed through unchanged (nothing to remove),
// and so is one that turns out to be entirely agent lines once a vocabulary is
// detected (an empty projection would be a silent regression to match_method:
// 'none' on every call, which is worse than reading the agent's words).
function adjusterTurnsOf(text) {
  var input = String(text || '')
  if (!input) return input

  var vocabName = detectLabelVocabulary(input)
  if (!vocabName) return input

  var vocab = TRANSCRIPT_LABEL_VOCABULARIES.filter(function (v) {
    return v.name === vocabName
  })[0]

  var adjusterLines = input
    .split('\n')
    .filter(function (line) {
      return vocab.adjuster.test(line)
    })
    .map(function (line) {
      return line.replace(vocab.adjuster, '')
    })

  return adjusterLines.length ? adjusterLines.join('\n') : input
}

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
// transcripts are concatenated in order. ElevenLabs is unaffected — it reads
// the recording itself from a URL (see buildElevenLabsRequest) rather than
// receiving an upload, and documents a 2 GB ceiling on that path.
var QWEN_MAX_SECONDS = 300
var QWEN_MAX_BYTES = 10 * 1024 * 1024
var WAV_HEADER_BYTES = 44
var WAV_PCM_FORMAT = 1

var TRANSCRIPTION_RETRY_BACKOFF_MS = 5000

var MANIFEST_FILE_NAME = 'manifest.json'

// Appended to the Jobs tab by ensureJobsColumns() at the top of every runner
// tick — writeRowFields throws on any header it cannot find, so these have to
// exist before the first write. Same pattern as CLAIMS_CALENDAR_COLUMNS.
var JOBS_TRANSCRIPTION_COLUMNS = [
  'call_folder_id',
  'transcript_elevenlabs_id',
  'transcript_qwen_id',
  'transcript_master',
  'transcript_master_id',
  'master_coverage',
  'transcription_sources',
  'extraction_input',
  'extraction_artifact_id',
]

// Same cap the Jobs sheet's other transcript columns use.
var TRANSCRIPT_CELL_MAX_CHARS = 45000

function getMasterTranscriptMode() {
  return getOptionalConfig('MASTER_TRANSCRIPT_MODE', 'shadow')
}

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
// Per-call Drive folder
// ---------------------------------------------------------------------------

// Every artifact from one call — audio, the three raw transcripts, the master,
// the manifest — lands in one folder named for that call. Idempotent on retry:
// call_folder_id on the job wins, so a second pass reuses the folder rather than
// creating a duplicate. Returns null when CALL_ARTIFACTS_FOLDER_ID is unset, and
// every caller degrades to the flat RECORDINGS_FOLDER_ID rather than throwing.
function getOrCreateCallFolder(job, claim) {
  var rootId = getOptionalConfig('CALL_ARTIFACTS_FOLDER_ID', '')
  if (!rootId) return null

  var name = buildCallFolderName(job, claim)

  if (job && job.call_folder_id) {
    try {
      var known = DriveApp.getFolderById(job.call_folder_id)
      // The folder is created by the webhook, before matching has run, so its
      // first name always says "unmatched". Rename once the claim is known.
      if (known.getName() !== name) known.setName(name)
      return known
    } catch (err) {
      logEvent('transcription.call_folder_missing', {
        capture_id: (job && job.capture_id) || '',
        call_folder_id: job.call_folder_id,
        error: String(err),
      })
    }
  }

  var root = DriveApp.getFolderById(rootId)
  var existing = root.getFoldersByName(name)
  return existing.hasNext() ? existing.next() : root.createFolder(name)
}

// Read-only sibling of getOrCreateCallFolder. Stage B and the replay entry
// points want the folder this call already has and must never make a new one —
// a created-on-read folder would be an empty folder that looks like a call.
function getExistingCallFolder(job) {
  if (!job || !job.call_folder_id) return null

  try {
    return DriveApp.getFolderById(job.call_folder_id)
  } catch (err) {
    logEvent('transcription.call_folder_missing', {
      capture_id: job.capture_id || '',
      call_folder_id: job.call_folder_id,
      error: String(err),
    })
    return null
  }
}

function buildCallFolderName(job, claim) {
  var who = (claim && claim.insured_last_name) || 'unmatched'
  var captureId = (job && job.capture_id) || 'unknown'
  return formatCallDate(job && job.call_started_at) + ' ' + who + ' ' + captureId
}

// call_started_at is an ISO string from Dograh's payload, but a hand-edited or
// re-read sheet cell can hand back a real Date instead.
function formatCallDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10)

  var date = value && typeof value.getTime === 'function' ? value : new Date(value)
  if (isNaN(date.getTime())) return String(value).slice(0, 10)

  return date.toISOString().slice(0, 10)
}

// Never overwrites. retranscribeJob() re-runs stage A against a folder that
// already holds the previous run's transcripts, and those are the thing you go
// back to read when a draft comes out wrong.
function writeCallArtifact(folder, fileName, content) {
  if (!folder) return ''
  return folder.createFile(nextArtifactName(folder, fileName), String(content)).getId()
}

function nextArtifactName(folder, fileName) {
  if (!folder.getFilesByName(fileName).hasNext()) return fileName

  var dot = fileName.lastIndexOf('.')
  var stem = dot === -1 ? fileName : fileName.slice(0, dot)
  var extension = dot === -1 ? '' : fileName.slice(dot)

  for (var version = 2; version < 100; version++) {
    var candidate = stem + '-' + version + extension
    if (!folder.getFilesByName(candidate).hasNext()) return candidate
  }

  return stem + '-' + new Date().getTime() + extension
}

function readCallArtifact(fileId) {
  if (!fileId) return ''

  try {
    return DriveApp.getFileById(fileId).getBlob().getDataAsString()
  } catch (err) {
    logEvent('transcription.artifact_read_failed', { file_id: fileId, error: String(err) })
    return ''
  }
}

// The manifest is the per-call audit record and the first thing to read when a
// draft comes out wrong. Unlike the transcripts it is updated in place, with one
// entry per stage-A pass under `runs`, so a re-transcribe adds to the history
// rather than replacing it.
function readManifest(folder) {
  if (!folder) return {}

  var files = folder.getFilesByName(MANIFEST_FILE_NAME)
  if (!files.hasNext()) return {}

  try {
    return JSON.parse(files.next().getBlob().getDataAsString()) || {}
  } catch (err) {
    logEvent('transcription.manifest_unparseable', { error: String(err) })
    return {}
  }
}

function writeManifest(folder, manifest) {
  if (!folder) return ''

  var body = JSON.stringify(manifest, null, 2)
  var files = folder.getFilesByName(MANIFEST_FILE_NAME)

  if (files.hasNext()) {
    var file = files.next()
    file.setContent(body)
    return file.getId()
  }

  return folder.createFile(MANIFEST_FILE_NAME, body, 'application/json').getId()
}

function appendManifestRun(folder, run) {
  if (!folder) return ''

  var manifest = readManifest(folder)
  manifest.runs = (manifest.runs || []).concat([run])
  return writeManifest(folder, manifest)
}

// ---------------------------------------------------------------------------
// Parallel ASR fan-out
// ---------------------------------------------------------------------------

// ElevenLabs fetches the recording itself via `source_url` rather than
// receiving an uploaded body, so the request is plain JSON — `keyterms` is a
// real array here, with none of the repeated-form-field problem a multipart
// upload would have. See docs/adr/007's amendment: the old hand-built
// multipart body was the thing that turned the recording into a JS byte array
// at all, and Apps Script has no typed-array form at the Blob boundary, so
// that array cost several times the recording's own size in V8 heap. This
// request never touches the audio bytes in this script — see
// withPubliclySharedFile for how ElevenLabs gets a URL it can reach.
function buildElevenLabsRequest(sourceUrl, keyterms, apiKey) {
  return {
    url: ELEVENLABS_URL,
    method: 'post',
    contentType: 'application/json',
    headers: { 'xi-api-key': apiKey },
    payload: JSON.stringify({
      model_id: TRANSCRIPTION_MODELS.elevenlabs.id,
      language_code: 'en',
      diarize: true,
      num_speakers: 2,
      timestamps_granularity: 'word',
      keyterms: keyterms || [],
      source_url: sourceUrl,
    }),
    muteHttpExceptions: true,
  }
}

// source_url has to be reachable without Google auth, and the recording lives
// in a private Drive folder — so the file is switched to "anyone with the
// link" for exactly the span of this call, in `finally` so the switch back
// happens even if ElevenLabs' request throws. This is a real, if brief,
// public-exposure window on claim audio (PII), not a scoped or self-expiring
// token — see docs/adr/007's amendment for why that trade-off was accepted
// over standing up signed Cloud Storage URLs, and why the revert has to be
// unconditional rather than a call after the fact that a thrown error would
// skip. If the initial setSharing call itself throws (an org policy blocking
// external sharing, for instance) nothing was changed, so there is nothing to
// revert and the error propagates to the caller as-is.
function withPubliclySharedFile(file, fn) {
  var originalAccess = file.getSharingAccess()
  var originalPermission = file.getSharingPermission()

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)

  try {
    return fn()
  } finally {
    file.setSharing(originalAccess, originalPermission)
  }
}

// Drive's unauthenticated direct-download endpoint — the one URL shape a
// link-shared file can be fetched from without a Google credential, which is
// all a third-party vendor can present.
function driveDirectDownloadUrl(fileId) {
  return 'https://drive.google.com/uc?export=download&id=' + fileId
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
    muteHttpExceptions: true,
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

// Returns one [startSec, endSec] pair per request to send, or an empty list when
// the audio cannot be made to fit — unsplittable because it is not PCM WAV, and
// over a cap. A single null entry means "send the payload whole, uncut".
//
// Spans rather than the slices themselves: cutting every slice up front held a
// second full copy of the audio alongside the original, and on a ten-minute call
// that pair alone was most of the heap. The caller cuts one span at a time.
function planQwenSpans(bytes, probe) {
  var fitsBytes = bytes.length <= QWEN_MAX_BYTES

  if (!probe) return fitsBytes ? [null] : []
  if (fitsBytes && probe.seconds <= QWEN_MAX_SECONDS) return [null]

  var span = qwenChunkSeconds(probe)
  if (span <= 0) return []

  var spans = []
  for (var start = 0; start < probe.seconds; start += span) {
    spans.push([start, Math.min(start + span, probe.seconds)])
  }

  return spans
}

// Runs the two ASR sources as two independent phases. Failure is per-source
// and never fatal: each source independently yields either text or empty, and
// the caller decides what to do with however many came back.
//
// ElevenLabs (phase A) sends a JSON request naming a URL for the recording —
// see buildElevenLabsRequest and withPubliclySharedFile — and never touches
// the audio bytes in this script at all. Qwen (phase B) is the only side that
// still turns the recording into a JS array, and only ever one span's worth at
// a time; see planQwenSpans for why that used to be the whole problem when
// ElevenLabs' now-removed hand-built multipart body ran in the same instant
// (docs/adr/007's amendment). Phase A running and failing independently of
// phase B is about isolation today, not memory: a slow or dead ElevenLabs
// share/fetch never blocks or corrupts the Qwen pass, and vice versa.
function transcribeInParallel(input) {
  var captureId = input.captureId || ''
  var results = {}
  var modes = []

  // A missing key is a configuration state, not a failure: the default mode on
  // first deploy is shadow, and a deploy that has not set ELEVENLABS_API_KEY yet
  if (input.elevenLabsKey) {
    results.elevenlabs = fetchElevenLabs(input, captureId)
    modes.push('elevenlabs')
  } else {
    logEvent('transcription.source_unconfigured', { capture_id: captureId, source: 'elevenlabs' })
  }

  if (input.openRouterKey) {
    var qwen = fetchQwen(input, captureId)

    if (qwen) {
      results.qwen = qwen.result
      modes.push('qwen:' + qwen.mode)
    }
  } else {
    logEvent('transcription.source_unconfigured', { capture_id: captureId, source: 'qwen' })
  }

  // fetch_mode still tells the manifest which shape it is reading, but it now
  // names both phases: 'elevenlabs+qwen:fetch_all' on the healthy path, and
  // 'qwen:sequential' when fetchAll threw and the slices went out one by one.
  results.fetch_mode = modes.length ? modes.join('+') : 'none'
  return results
}

// Phase A. A sharing failure (an org policy blocking external sharing, for
// instance) is caught here rather than left to throw out of the pass — the
// floor is still the job's own voice-platform transcript, so a dead vendor
// degrades the run exactly like an ordinary fetch failure would.
function fetchElevenLabs(input, captureId) {
  var startedAt = Date.now()
  var result

  try {
    result = withPubliclySharedFile(input.audioFile, function () {
      var sourceUrl = driveDirectDownloadUrl(input.audioFile.getId())
      var request = buildElevenLabsRequest(sourceUrl, input.keyterms || [], input.elevenLabsKey)
      return resolveWithRetry('elevenlabs', request, safeFetch(request), captureId)
    })
  } catch (err) {
    logEvent('transcription.elevenlabs_share_failed', {
      capture_id: captureId,
      error: String(err),
    })
    result = { source: 'elevenlabs', text: '', ok: false, status: 0, error: String(err) }
  }

  result.latency_ms = Date.now() - startedAt
  logSourceFinished(captureId, result, 1)
  return result
}

// Phase B. The slices keep their concurrency: by the time they reach here they
// are base64 strings, roughly a byte of heap per character rather than the four
// to eight an array element costs, so holding all of them is affordable.
function fetchQwen(input, captureId) {
  var requests = planQwenRequests(input, captureId)
  if (!requests.length) return null

  var startedAt = Date.now()
  var batch = fetchAllWithFallback(requests, captureId)
  // fetchAll issues every slice concurrently, so there is one wall clock for the
  // batch rather than a latency per slice. The sequential fallback shares it too.
  var latencyMs = Date.now() - startedAt

  var parts = requests.map(function (request, index) {
    return resolveWithRetry('qwen', request, batch.responses[index], captureId)
  })

  var result = combineChunks('qwen', parts)
  result.latency_ms = latencyMs
  logSourceFinished(captureId, result, parts.length)
  return { result: result, mode: batch.mode }
}

// A 429 or a 5xx earns one more try on its own; anything else stands as it came
// back. The request object is still held here, so a retry costs no re-encoding.
function resolveWithRetry(label, request, response, captureId) {
  var result = resolveSourceResponse(label, response)
  if (result.ok || !isRetryableStatus(result.status)) return result

  logEvent('transcription.retry', { capture_id: captureId, source: label, status: result.status })
  Utilities.sleep(TRANSCRIPTION_RETRY_BACKOFF_MS)
  return resolveSourceResponse(label, safeFetch(request))
}

function logSourceFinished(captureId, result, chunks) {
  logEvent('transcription.source_finished', {
    capture_id: captureId,
    source: result.source,
    ok: result.ok,
    status: result.status,
    chars: String(result.text || '').length,
    chunks: chunks,
    latency_ms: result.latency_ms,
    // The vendor's own words for why it refused. Without this a 400 logs as
    // ok:false with no reason attached, and the body resolveSourceResponse
    // captured dies here. A 4xx is not retryable, so this line is the only
    // record of the failure the call ever produces.
    error: result.ok ? '' : String(result.error || ''),
  })
}

// Qwen's requests, built one slice at a time: each span is cut, encoded, and
// dropped before the next is cut, so the pass never holds more than the source
// bytes plus a single slice. Encoding still happens before anything is sent, so
// a slice that will not encode drops the whole source cleanly instead of sending
// a transcript with a hole where one slice should have been.
function planQwenRequests(input, captureId) {
  var bytes = input.audioBlob.getBytes()
  var probe = probeWav(bytes)
  var spans = planQwenSpans(bytes, probe)

  if (!spans.length) {
    logEvent('transcription.audio_too_large', {
      capture_id: captureId,
      bytes: bytes.length,
      seconds: probe ? probe.seconds : '',
      max_bytes: QWEN_MAX_BYTES,
      max_seconds: QWEN_MAX_SECONDS,
      splittable: Boolean(probe),
    })
    return []
  }

  var requests = []

  for (var i = 0; i < spans.length; i++) {
    var span = spans[i]
    // A null span is the whole payload uncut; otherwise the slice is always WAV
    // whatever the original container was, because sliceWav writes its own header.
    var base64 = encodeAudioBase64(
      span ? sliceWav(bytes, probe, span[0], span[1]) : bytes,
      captureId,
    )
    if (!base64) return []

    requests.push(buildQwenRequest(base64, probe ? 'wav' : input.format, input.openRouterKey))
  }

  if (requests.length > 1) {
    logEvent('transcription.audio_split', {
      capture_id: captureId,
      chunks: requests.length,
      seconds: probe.seconds,
      chunk_seconds: qwenChunkSeconds(probe),
    })
  }

  return requests
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

function encodeAudioBase64(bytes, captureId) {
  try {
    return Utilities.base64Encode(bytes)
  } catch (err) {
    logEvent('transcription.audio_encode_failed', {
      capture_id: captureId,
      error: String(err),
    })
    return ''
  }
}

// fetchAll returns non-2xx as ordinary responses, but a transport error throws
// for the whole batch — which would lose every slice because one of them failed
// to go out. Fall back to sequential fetches so each slice gets its own chance.
function fetchAllWithFallback(requests, captureId) {
  try {
    return { responses: UrlFetchApp.fetchAll(requests), mode: 'fetch_all' }
  } catch (err) {
    logEvent('transcription.fetch_all_failed', {
      capture_id: captureId,
      error: String(err),
    })
    return {
      responses: requests.map(function (request) {
        return safeFetch(request)
      }),
      mode: 'sequential',
    }
  }
}

function safeFetch(request) {
  try {
    return UrlFetchApp.fetch(request.url, request)
  } catch (err) {
    logEvent('transcription.fetch_failed', { url: request.url, error: String(err) })
    return null
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500
}

function resolveSourceResponse(label, response) {
  if (!response) return { source: label, text: '', ok: false, status: 0, error: 'no_response' }

  var status = response.getResponseCode()
  var bodyText = response.getContentText()

  // 2000 chars, matching describeError()'s stack cap in log.js: an ElevenLabs
  // 400 carries its reason in a `detail` array that routinely runs past 500.
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
// prompt, not the source of speaker identity — Dograh's turn structure is the
// skeleton, so nothing downstream reads these speaker IDs.
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

// ---------------------------------------------------------------------------
// Stage A orchestration
// ---------------------------------------------------------------------------

// Returns the Jobs-sheet fields stage A writes. Never throws for a transcription
// problem: the floor is the job's own voice-platform transcript, which is
// exactly today's behavior, so a dead vendor degrades the run rather than
// failing the job.
function runTranscriptionPass(job, claim) {
  var mode = getMasterTranscriptMode()
  var captureId = job.capture_id
  var voiceSource = VOICE_PLATFORM_SOURCES.indexOf(job.source) !== -1 ? job.source : ''

  if (mode === 'off') {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'mode_off' })
    return { extraction_input: voiceSource || 'dograh' }
  }

  if (!voiceSource) {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'unsupported_source' })
    return {}
  }

  if (!job.audio_drive_id) {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'no_audio' })
    return { extraction_input: voiceSource }
  }

  var folder = getOrCreateCallFolder(job, claim)
  var glossary = loadGlossary()
  var keyterms = buildKeyterms(claim, glossary, getOptionalConfig('ADJUSTER_NAME', 'Brandon'))
  var audioFile = DriveApp.getFileById(job.audio_drive_id)

  var asr = transcribeInParallel({
    captureId: captureId,
    audioFile: audioFile,
    audioBlob: audioFile.getBlob(),
    format: guessAudioExtension(audioFile.getName(), 'wav'),
    keyterms: keyterms,
    elevenLabsKey: getOptionalConfig('ELEVENLABS_API_KEY', ''),
    openRouterKey: getOptionalConfig('OPENROUTER_API_KEY', ''),
  })

  var precedence = ['elevenlabs', 'qwen', voiceSource]
  var sources = {
    elevenlabs: asr.elevenlabs || { text: '' },
    qwen: asr.qwen || { text: '' },
  }
  sources[voiceSource] = { text: String(job.transcript || '') }

  var artifactIds = writeRawTranscripts(folder, sources)
  var available = availableSources(sources, precedence)
  var merged = mergeIfPossible(job, claim, glossary, sources, available, precedence)
  var fallback = selectFallbackTranscript(sources, precedence)

  var accepted = Boolean(merged && merged.accepted)
  var masterId =
    merged && merged.text ? writeCallArtifact(folder, 'transcript-master.txt', merged.text) : ''
  var resolvedSource = accepted ? 'master' : fallback.source
  // shadow runs everything and writes every artifact but leaves the draft on
  // today's input, so the real output can be read against real calls at no risk.
  var extractionInput = mode === 'live' ? resolvedSource : voiceSource

  appendManifestRun(folder, {
    stage: 'transcription',
    mode: mode,
    at: new Date().toISOString(),
    capture_id: captureId,
    claim_id: (claim && claim.claim_id) || '',
    voice_platform: job.source || '',
    match_method: job.match_method || '',
    fetch_mode: asr.fetch_mode,
    keyterm_count: keyterms.length,
    sources: describeSourcesForManifest(sources, precedence),
    models: {
      elevenlabs: TRANSCRIPTION_MODELS.elevenlabs.id,
      qwen: TRANSCRIPTION_MODELS.qwen.id,
      merge: merged ? merged.model : '',
    },
    master_accepted: accepted,
    master_coverage: merged ? merged.coverage : null,
    contested_passages: merged ? merged.contested_passages : [],
    failing_shingles: merged ? merged.failing : [],
    extraction_input: extractionInput,
  })

  logEvent('transcription.pass_complete', {
    capture_id: captureId,
    mode: mode,
    sources: available.join(','),
    master_accepted: accepted,
    master_coverage: merged ? merged.coverage : '',
    extraction_input: extractionInput,
  })

  var fields = {
    transcript_elevenlabs_id: artifactIds.elevenlabs,
    transcript_qwen_id: artifactIds.qwen,
    transcript_master: merged ? merged.text.slice(0, TRANSCRIPT_CELL_MAX_CHARS) : '',
    transcript_master_id: masterId,
    master_coverage: merged ? merged.coverage : '',
    transcription_sources: available.join(','),
    extraction_input: extractionInput,
  }

  if (folder) fields.call_folder_id = folder.getId()
  return fields
}

function writeRawTranscripts(folder, sources) {
  var ids = { elevenlabs: '', qwen: '' }
  if (!folder) return ids

  if (sources.elevenlabs.text) {
    ids.elevenlabs = writeCallArtifact(folder, 'transcript-elevenlabs.txt', sources.elevenlabs.text)
  }

  if (sources.elevenlabs.words && sources.elevenlabs.words.length) {
    writeCallArtifact(
      folder,
      'transcript-elevenlabs-words.json',
      JSON.stringify(sources.elevenlabs.words),
    )
  }

  if (sources.qwen.text) {
    ids.qwen = writeCallArtifact(folder, 'transcript-qwen.txt', sources.qwen.text)
  }

  return ids
}

// Three sources merge; two merge and log the loss; one skips the merge entirely
// (the master would just be that source restated by a model, which is exactly
// what the verbatim constraint exists to prevent). Zero cannot happen — the
// job's own voice-platform transcript is already on the job before stage A
// runs.
function mergeIfPossible(job, claim, glossary, sources, available, precedence) {
  var order = precedence || SOURCE_PRECEDENCE

  if (available.length < 2) {
    logEvent('transcription.single_source', {
      capture_id: job.capture_id,
      source: available[0] || '',
    })
    return null
  }

  if (available.length === 2) {
    logEvent('transcription.degraded', {
      capture_id: job.capture_id,
      available: available.join(','),
      lost: order
        .filter(function (name) {
          return available.indexOf(name) === -1
        })
        .join(','),
    })
  }

  try {
    return buildGatedMasterTranscript({
      apiKey: getConfig('OPENROUTER_API_KEY'),
      model: getOptionalConfig('MASTER_TRANSCRIPT_MODEL', getConfig('OPENROUTER_MODEL')),
      fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
      captureId: job.capture_id,
      sources: sources,
      claim: claim,
      glossary: glossary,
      adjusterName: getOptionalConfig('ADJUSTER_NAME', 'Brandon'),
      precedence: order,
    })
  } catch (err) {
    var described = describeError(err)
    logEvent('master_transcript.call_failed', {
      capture_id: job.capture_id,
      error: described.error,
      stack: described.stack,
    })
    return null
  }
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
// Stage B input
// ---------------------------------------------------------------------------

// extraction_input is decided in stage A and recorded on the job, so stage B
// never re-derives it — it just loads whatever the earlier stage resolved to.
// Every path degrades to the job's own voice-platform transcript, today's
// behavior, keyed by whichever platform actually produced it (job.source)
// rather than a fixed 'dograh' literal — see VOICE_PLATFORM_SOURCES.
function resolveExtractionTranscript(job) {
  var voiceText = String(job.transcript || '')
  var voiceFallback = {
    source: VOICE_PLATFORM_SOURCES.indexOf(job.source) !== -1 ? job.source : '',
    transcript: voiceText,
    haystack: voiceText,
  }
  var input = String(job.extraction_input || '')

  if (input === 'master') {
    var masterText =
      readCallArtifact(job.transcript_master_id) || String(job.transcript_master || '')
    if (masterText) {
      return { source: 'master', transcript: masterText, haystack: buildSpanHaystack(masterText) }
    }
    logEvent('transcription.master_unreadable', { capture_id: job.capture_id })
    return voiceFallback
  }

  if (input === 'elevenlabs' || input === 'qwen') {
    var fileId = input === 'elevenlabs' ? job.transcript_elevenlabs_id : job.transcript_qwen_id
    var raw = readCallArtifact(fileId)
    if (raw) return { source: input, transcript: raw, haystack: raw }

    logEvent('transcription.fallback_unreadable', { capture_id: job.capture_id, source: input })
  }

  return voiceFallback
}

// ---------------------------------------------------------------------------
// Manual re-run
// ---------------------------------------------------------------------------

// Run from the Apps Script editor after a prompt or keyterm change. Clears the
// transcription columns and puts the job back to pending so the runner redoes
// stage A. call_folder_id is deliberately kept: the previous run's artifacts stay
// where they are and the new ones version alongside them.
function retranscribeJob(captureId) {
  var job = getJobByCaptureId(captureId)
  if (!job) throw new Error('No job for capture_id: ' + captureId)

  ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)

  upsertJob(captureId, {
    transcript_elevenlabs_id: '',
    transcript_qwen_id: '',
    transcript_master: '',
    transcript_master_id: '',
    master_coverage: '',
    transcription_sources: '',
    extraction_input: '',
    status: 'pending',
    lease_until: '',
    attempts: 0,
    error: '',
  })

  logEvent('transcription.retranscribe_queued', {
    capture_id: captureId,
    previous_status: job.status,
  })

  return true
}
