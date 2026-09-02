// The Google-side half of transcription: the per-call Drive folder, its
// artifacts, the call manifest, and the stage-A orchestration that ties them to
// core. The runtime-agnostic half — keyterms, request building, WAV probing and
// slicing, response parsing, source precedence, the fan-out itself — lives in
// core/transcription.js. See docs/specs/012, docs/specs/016, docs/adr/007, and
// docs/adr/009.

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
  var config = buildTranscriptionConfig()
  var keyterms = buildKeyterms(claim, glossary, config.adjusterName)
  var audioFile = DriveApp.getFileById(job.audio_drive_id)
  var audioBlob = audioFile.getBlob()

  // The blob is unwrapped here rather than handed across: core takes a plain
  // { bytes, name, contentType } record and knows nothing about Drive.
  var asr = coreTranscribe({
    captureId: captureId,
    audio: {
      bytes: audioBlob.getBytes(),
      name: audioBlob.getName(),
      contentType: audioBlob.getContentType(),
    },
    format: guessAudioExtension(audioFile.getName(), 'wav'),
    keyterms: keyterms,
    config: config,
    deps: buildCoreDeps(),
  })

  var precedence = ['elevenlabs', 'qwen', voiceSource]
  var sources = {
    elevenlabs: asr.sources.elevenlabs || { text: '' },
    qwen: asr.sources.qwen || { text: '' },
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

// The merge's decision logic lives in core (coreMergeSources). What stays here
// is the try that wraps it, and it wraps the config assembly too: getConfig
// throws on a missing script property, and a missing property has always
// degraded this run to a raw fallback transcript in exactly the same way a
// failed merge call does. Building the config outside the try would turn that
// into a failed job.
function mergeIfPossible(job, claim, glossary, sources, available, precedence) {
  try {
    return coreMergeSources({
      captureId: job.capture_id,
      sources: sources,
      available: available,
      precedence: precedence,
      claim: claim,
      glossary: glossary,
      config: buildMergeConfig(),
      deps: buildCoreDeps(),
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
