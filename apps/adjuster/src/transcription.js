// Batch transcription layer for Dograh calls — see docs/specs/012 and
// docs/adr/007. Dograh's own transcript is a real-time Deepgram stream over a
// mobile codec: it hears each phrase once, live, and it is the weakest link in
// the pipeline. This module re-reads the saved recording with two independent
// high-accuracy batch models and hands all three readings to the merge step in
// llm/masterTranscript.js.
//
// Runtime notes (Apps Script, not Node): there is no Promise and no async, so
// "in parallel" is UrlFetchApp.fetchAll(requests). scripts/stt-transcribe.mjs
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
    vocabField: 'context',
  },
}

// One ordering governs every degraded path: which source wins a disagreement
// inside the merge, and which source becomes the master when there is no usable
// merge. Dograh is last on wording (single-pass, real-time, lossy codec) and
// first on turn structure (it is the only source that knows when the agent
// spoke). Defined once, consumed by both the merge prompt and the fallback.
var SOURCE_PRECEDENCE = ['elevenlabs', 'qwen', 'dograh']

// ElevenLabs' documented keyterm limits.
var KEYTERM_MAX_TERMS = 1000
var KEYTERM_MAX_CHARS = 50
var CLAIM_KEYTERM_FIELDS = ['insured_last_name', 'address_line1', 'city', 'carrier', 'claim_number']

// UrlFetchApp caps a payload at 50MB. Qwen takes the audio as base64 inside a
// JSON body, so a long call can cross that; 16kHz 16-bit mono wav is ~1.9MB/min,
// which puts 50MB of base64 at roughly 17 minutes. Skip Qwen past this guard and
// merge on what is left. ElevenLabs is unaffected — it takes the raw blob as
// multipart, not base64.
var QWEN_MAX_BASE64_CHARS = 35 * 1024 * 1024

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
    var term = terms[i].trim().slice(0, KEYTERM_MAX_CHARS)
    if (!term) continue

    var key = term.toLowerCase()
    if (seen[key]) continue

    seen[key] = true
    capped.push(term)
  }

  return capped
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

function buildElevenLabsRequest(audioBlob, keyterms, apiKey) {
  // No contentType: handing UrlFetchApp a payload object containing a Blob is
  // what makes it build the multipart/form-data body ElevenLabs expects.
  return {
    url: ELEVENLABS_URL,
    method: 'post',
    headers: { 'xi-api-key': apiKey },
    payload: {
      file: audioBlob,
      model_id: TRANSCRIPTION_MODELS.elevenlabs.id,
      language_code: 'en',
      diarize: 'true',
      num_speakers: '2',
      timestamps_granularity: 'word',
      keyterms: JSON.stringify(keyterms || []),
    },
    muteHttpExceptions: true,
  }
}

function buildQwenRequest(audioBase64, format, keyterms, apiKey) {
  var model = TRANSCRIPTION_MODELS.qwen
  var providerOptions = {}
  providerOptions[model.provider] = {}
  providerOptions[model.provider][model.vocabField] = (keyterms || []).join(', ')

  return {
    url: OPENROUTER_TRANSCRIPTION_URL,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model.id,
      input_audio: { data: audioBase64, format: format || 'wav' },
      language: 'en',
      // allow_fallbacks: false because the keyterm biasing only exists on the
      // alibaba route — a silent fallback would drop it without saying so.
      provider: {
        order: [model.provider],
        allow_fallbacks: false,
        options: providerOptions,
      },
    }),
    muteHttpExceptions: true,
  }
}

// Issues both ASR calls through one fetchAll. Failure is per-source and never
// fatal: each source independently yields either text or empty, and the caller
// decides what to do with however many came back.
function transcribeInParallel(input) {
  var captureId = input.captureId || ''
  var keyterms = input.keyterms || []
  var requests = []
  var labels = []

  // A missing key is a configuration state, not a failure: the default mode on
  // first deploy is shadow, and a deploy that has not set ELEVENLABS_API_KEY yet
  // should lose that one source, not fail every job it touches.
  if (input.elevenLabsKey) {
    requests.push(buildElevenLabsRequest(input.audioBlob, keyterms, input.elevenLabsKey))
    labels.push('elevenlabs')
  } else {
    logEvent('transcription.source_unconfigured', { capture_id: captureId, source: 'elevenlabs' })
  }

  var audioBase64 = input.openRouterKey ? encodeAudioBase64(input.audioBlob, captureId) : ''

  if (!input.openRouterKey) {
    logEvent('transcription.source_unconfigured', { capture_id: captureId, source: 'qwen' })
  }

  if (audioBase64 && audioBase64.length <= QWEN_MAX_BASE64_CHARS) {
    requests.push(buildQwenRequest(audioBase64, input.format, keyterms, input.openRouterKey))
    labels.push('qwen')
  } else if (audioBase64) {
    logEvent('transcription.audio_too_large', {
      capture_id: captureId,
      base64_chars: audioBase64.length,
      limit: QWEN_MAX_BASE64_CHARS,
    })
  }

  if (!requests.length) return { fetch_mode: 'none' }

  var startedAt = Date.now()
  var batch = fetchAllWithFallback(requests, captureId)
  // fetchAll issues both concurrently, so there is one wall clock for the pair
  // rather than a latency per source. The sequential fallback shares it too;
  // fetch_mode in the manifest is what says which of the two you are reading.
  var latencyMs = Date.now() - startedAt

  var results = {}

  labels.forEach(function (label, index) {
    var result = resolveSourceResponse(label, batch.responses[index])

    if (!result.ok && isRetryableStatus(result.status)) {
      logEvent('transcription.retry', {
        capture_id: captureId,
        source: label,
        status: result.status,
      })
      Utilities.sleep(TRANSCRIPTION_RETRY_BACKOFF_MS)
      result = resolveSourceResponse(label, safeFetch(requests[index]))
    }

    result.latency_ms = latencyMs
    results[label] = result

    logEvent('transcription.source_finished', {
      capture_id: captureId,
      source: label,
      ok: result.ok,
      status: result.status,
      chars: String(result.text || '').length,
      latency_ms: latencyMs,
    })
  })

  results.fetch_mode = batch.mode
  return results
}

function encodeAudioBase64(audioBlob, captureId) {
  try {
    return Utilities.base64Encode(audioBlob.getBytes())
  } catch (err) {
    logEvent('transcription.audio_encode_failed', {
      capture_id: captureId,
      error: String(err),
    })
    return ''
  }
}

// fetchAll returns non-2xx as ordinary responses, but a transport error throws
// for the whole batch — which would let one dead vendor take out the other. Fall
// back to two sequential calls so each source still gets its own chance.
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

  if (status !== 200) {
    return { source: label, text: '', ok: false, status: status, error: bodyText.slice(0, 500) }
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
function selectFallbackTranscript(sources) {
  for (var i = 0; i < SOURCE_PRECEDENCE.length; i++) {
    var name = SOURCE_PRECEDENCE[i]
    var entry = (sources || {})[name]
    var text = entry ? String(entry.text || '') : ''
    if (text.trim()) return { source: name, text: text }
  }

  return { source: '', text: '' }
}

function availableSources(sources) {
  return SOURCE_PRECEDENCE.filter(function (name) {
    var entry = (sources || {})[name]
    return entry && String(entry.text || '').trim()
  })
}

// ---------------------------------------------------------------------------
// Stage A orchestration
// ---------------------------------------------------------------------------

// Returns the Jobs-sheet fields stage A writes. Never throws for a transcription
// problem: the floor is Dograh's own transcript, which is exactly today's
// behavior, so a dead vendor degrades the run rather than failing the job.
function runTranscriptionPass(job, claim) {
  var mode = getMasterTranscriptMode()
  var captureId = job.capture_id

  if (mode === 'off') {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'mode_off' })
    return { extraction_input: 'dograh' }
  }

  if (job.source !== 'dograh') {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'not_dograh' })
    return {}
  }

  if (!job.audio_drive_id) {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'no_audio' })
    return { extraction_input: 'dograh' }
  }

  var folder = getOrCreateCallFolder(job, claim)
  var glossary = loadGlossary()
  var keyterms = buildKeyterms(claim, glossary, getOptionalConfig('ADJUSTER_NAME', 'Brandon'))
  var audioFile = DriveApp.getFileById(job.audio_drive_id)

  var asr = transcribeInParallel({
    captureId: captureId,
    audioBlob: audioFile.getBlob(),
    format: guessAudioExtension(audioFile.getName(), 'wav'),
    keyterms: keyterms,
    elevenLabsKey: getOptionalConfig('ELEVENLABS_API_KEY', ''),
    openRouterKey: getOptionalConfig('OPENROUTER_API_KEY', ''),
  })

  var sources = {
    elevenlabs: asr.elevenlabs || { text: '' },
    qwen: asr.qwen || { text: '' },
    dograh: { text: String(job.transcript || '') },
  }

  var artifactIds = writeRawTranscripts(folder, sources)
  var available = availableSources(sources)
  var merged = mergeIfPossible(job, claim, glossary, sources, available)
  var fallback = selectFallbackTranscript(sources)

  var accepted = Boolean(merged && merged.accepted)
  var masterId =
    merged && merged.text ? writeCallArtifact(folder, 'transcript-master.txt', merged.text) : ''
  var resolvedSource = accepted ? 'master' : fallback.source
  // shadow runs everything and writes every artifact but leaves the draft on
  // today's input, so the real output can be read against real calls at no risk.
  var extractionInput = mode === 'live' ? resolvedSource : 'dograh'

  appendManifestRun(folder, {
    stage: 'transcription',
    mode: mode,
    at: new Date().toISOString(),
    capture_id: captureId,
    claim_id: (claim && claim.claim_id) || '',
    match_method: job.match_method || '',
    fetch_mode: asr.fetch_mode,
    keyterm_count: keyterms.length,
    sources: describeSourcesForManifest(sources),
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
// what the verbatim constraint exists to prevent). Zero cannot happen — Dograh's
// transcript is already on the job before stage A runs.
function mergeIfPossible(job, claim, glossary, sources, available) {
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
      lost: SOURCE_PRECEDENCE.filter(function (name) {
        return available.indexOf(name) === -1
      }).join(','),
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

function describeSourcesForManifest(sources) {
  return SOURCE_PRECEDENCE.map(function (name) {
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
// Every path degrades to Dograh's transcript, today's behavior.
function resolveExtractionTranscript(job) {
  var dograhText = String(job.transcript || '')
  var dograh = {
    source: job.source === 'dograh' ? 'dograh' : '',
    transcript: dograhText,
    haystack: dograhText,
  }
  var input = String(job.extraction_input || '')

  if (input === 'master') {
    var masterText =
      readCallArtifact(job.transcript_master_id) || String(job.transcript_master || '')
    if (masterText) {
      return { source: 'master', transcript: masterText, haystack: buildSpanHaystack(masterText) }
    }
    logEvent('transcription.master_unreadable', { capture_id: job.capture_id })
    return dograh
  }

  if (input === 'elevenlabs' || input === 'qwen') {
    var fileId = input === 'elevenlabs' ? job.transcript_elevenlabs_id : job.transcript_qwen_id
    var raw = readCallArtifact(fileId)
    if (raw) return { source: input, transcript: raw, haystack: raw }

    logEvent('transcription.fallback_unreadable', { capture_id: job.capture_id, source: input })
  }

  return dograh
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
