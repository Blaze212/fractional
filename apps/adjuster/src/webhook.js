// Logging contract: every request that reaches doPost produces at least two log
// lines — webhook.received before any parsing or auth, and exactly one terminal
// line (webhook.accepted / webhook.denied / webhook.failed) from the finally
// block. Rejections carry a reason; failures carry the error and stack. Nothing
// between them is allowed to throw past doPost, so a request can never leave
// without a recorded outcome.
function doPost(e) {
  var startedAt = Date.now()
  var params = (e && e.parameter) || {}
  var event = params.event || 'unknown'
  var terminal = null

  logEvent('webhook.received', {
    telnyx_event: event,
    param_names: Object.keys(params).sort().join(','),
    params: redactParams(params),
    post_body: describePostData(e),
  })

  try {
    terminal = routeWebhook(event, params, e)
    return terminal.response
  } catch (err) {
    var described = describeError(err)
    terminal = {
      outcome: 'failed',
      reason: described.error,
      stack: described.stack,
      response: ContentService.createTextOutput('Error'),
    }
    return terminal.response
  } finally {
    logEvent('webhook.' + ((terminal && terminal.outcome) || 'failed'), {
      telnyx_event: event,
      capture_id: (terminal && terminal.captureId) || '',
      reason: (terminal && terminal.reason) || '',
      stack: (terminal && terminal.stack) || '',
      ms: Date.now() - startedAt,
    })
  }
}

// Reachability probe. Hitting the deployment URL in a browser or with curl proves
// the URL is live and running current code without needing a call from Telnyx.
function doGet() {
  var responseBody = 'adjuster-webhook ok'
  logEvent('webhook.ping', { response_body: responseBody })
  return ContentService.createTextOutput(responseBody)
}

function routeWebhook(event, params, e) {
  if (params.t !== getConfig('WEBHOOK_SECRET')) {
    return denied('bad_secret', '', 'Forbidden')
  }

  // Dograh's Notetaker voice agent (workflow id 10551) posts one JSON body per
  // completed call — branches off right after the shared secret check, same
  // as every other event below.
  if (event === 'dograh_notetaker') {
    // Raw, unparsed body — logged before parseJsonBody touches it so a webhook
    // that arrives with gathered_context already empty (a Dograh-side timing
    // issue between extraction and the webhook firing, not a bug in our
    // parsing) is visible in the server log without having to reproduce it.
    logServerOnly('dograh_notetaker.raw_payload', {
      post_data_type: (e && e.postData && e.postData.type) || '',
      post_data_contents: (e && e.postData && e.postData.contents) || '',
    })

    var body = parseJsonBody(e)
    var captureId = String(body.capture_id || '')
    if (!captureId) return denied('missing_capture_id', '', 'Bad Request')
    return accepted(captureId, handleDograhNotetaker(captureId, body))
  }

  // Retell posts one JSON body per lifecycle event ({event, call} — call_ended,
  // call_analyzed, and others we don't act on) — same reason as
  // dograh_notetaker above, it has to branch off before the Telnyx shape checks
  // below. Verified with its own second gate: Apps Script's doPost(e) has no
  // access to HTTP request headers at all (a platform limitation, not a
  // workaround we chose not to use — see apps/bh-systems/src/worker.js's
  // comment on proxyToAppsScript), so the bh-systems Worker proxy reads
  // Retell's X-Retell-Signature header and forwards it here as the retell_sig
  // query param instead. Verified before any of the body's contents are
  // trusted, same as the shared-secret gate above applying to every event.
  if (event === 'retell') {
    var sigResult = verifyRetellSignature(params.retell_sig, e)
    if (!sigResult.ok) return denied(sigResult.reason, '', 'Forbidden')

    logServerOnly('retell.raw_payload', {
      post_data_type: (e && e.postData && e.postData.type) || '',
      post_data_contents: (e && e.postData && e.postData.contents) || '',
    })

    var retellBody = parseJsonBody(e)
    var call = retellBody.call || {}
    var callId = String(call.call_id || '')
    if (!callId) return denied('missing_call_id', '', 'Bad Request')

    var retellCaptureId = 'retell-' + callId
    var retellEventType = String(retellBody.event || '')

    if (retellEventType === 'call_ended') {
      return accepted(retellCaptureId, handleRetellCallEnded(retellCaptureId, call))
    }
    if (retellEventType === 'call_analyzed') {
      return accepted(retellCaptureId, handleRetellCallAnalyzed(retellCaptureId, call))
    }

    // call_started and any other lifecycle event we don't act on — acked OK so
    // Retell doesn't treat it as a delivery failure and retry it.
    return denied('retell_unhandled_event', retellCaptureId, 'OK')
  }

  // Dograh's Pre-Call Data Fetch (Beta Notetaker workflow's Start Call node)
  // POSTs here the instant an inbound call arrives, before the agent speaks —
  // same shared-secret gate as every other event, no CallSessionId yet since
  // the call hasn't been assigned one from our side at this point.
  if (event === 'dograh_pre_call') {
    var preCallBody = parseJsonBody(e)
    var fromNumber = (preCallBody.call_inbound && preCallBody.call_inbound.from_number) || ''
    return accepted('precall:' + fromNumber, handleDograhPreCall())
  }

  // Retell's inbound webhook — same shape and same "before the call has a
  // CallSessionId" placement as dograh_pre_call above. See spec 015 and
  // handleRetellInbound().
  if (event === 'retell_inbound') {
    var retellBody = parseJsonBody(e)
    var retellFromNumber = (retellBody.call_inbound && retellBody.call_inbound.from_number) || ''
    return accepted('retell_inbound:' + retellFromNumber, handleRetellInbound())
  }

  // Manual test injection — see scripts/adjuster-inject-test-job.mjs. Lets
  // someone who pulled a transcript and recording off the Dograh dashboard by
  // hand (no live call, so no real dograh_notetaker webhook ever fired) drop
  // them into the Jobs sheet as though it had. Same shared-secret gate, no
  // CallSessionId, same reason as the two Dograh events above.
  if (event === 'manual_recording_inject') {
    var manualBody = parseJsonBody(e)
    var manualCaptureId = String(manualBody.capture_id || '')
    if (!manualCaptureId) return denied('missing_capture_id', '', 'Bad Request')
    if (!manualBody.transcript) return denied('missing_transcript', manualCaptureId, 'Bad Request')
    if (!manualBody.audio_base64) return denied('missing_audio', manualCaptureId, 'Bad Request')
    return accepted(manualCaptureId, handleManualRecordingInject(manualCaptureId, manualBody))
  }

  return denied('unknown_event', '', 'OK')
}

function accepted(captureId, response) {
  return { outcome: 'accepted', captureId: captureId, reason: '', response: response }
}

function denied(reason, captureId, body) {
  return {
    outcome: 'denied',
    captureId: captureId || '',
    reason: reason,
    response: ContentService.createTextOutput(body),
  }
}

// params.t is the shared secret and params.retell_sig is Retell's forwarded
// HMAC signature — never log either. Values are truncated so a long
// transcript cannot push the terminal outcome line out of a readable log entry.
var SECRET_PARAM_KEYS = ['t', 'retell_sig']

function redactParams(params) {
  var safe = {}
  Object.keys(params).forEach(function (key) {
    if (SECRET_PARAM_KEYS.indexOf(key) !== -1) {
      safe[key] = params[key] ? '[redacted]' : '[missing]'
      return
    }
    safe[key] = String(params[key]).slice(0, 300)
  })
  return safe
}

// A JSON-body event (Dograh, Retell) with an empty e.postData is a real
// misconfiguration — logging its shape makes that obvious instead of looking
// like a silent parsing failure.
function describePostData(e) {
  if (!e || !e.postData) return ''
  return String(e.postData.type || '') + ' ' + String(e.postData.contents || '').slice(0, 1000)
}

// Jobs-sheet columns shared by every "live extraction" source (a platform's own
// LLM handing back a final per-field value during the call, rather than a
// verbatim transcript span — see validateLiveFields()'s comment in validate.js).
// live_fields/live_fields_validated are renames of the columns this file used to
// call dograh_fields/dograh_validated; live_fields_source is new. A production
// Jobs sheet still has the old dograh_fields/dograh_validated headers sitting
// unused — same "no migration" precedent copyRecordingToDrive's comment already
// documents for the flat recordings folder — so every write site here calls
// ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS) first, same as
// JOBS_TRANSCRIPTION_COLUMNS below.
var JOBS_LIVE_FIELDS_COLUMNS = [
  'live_fields',
  'live_fields_validated',
  'live_fields_source',
  'call_analysis_data',
]

// Dograh's webhook node payload_template mirrors apps/adjuster/template/enums.json
// 1:1 (see the "Notetaker Export" node on workflow id 10551) — every gathered_context
// field lands in `body` under the exact same tag name validateLiveFields() and
// loadEnums() already use, so no field-name translation happens here. capture_id
// is the "dograh-{{workflow_run_id}}" string Dograh's payload template renders,
// namespaced so it can never collide with a Telnyx CallSessionId in the same
// Jobs sheet.
//
// The recording is copied into RECORDINGS_FOLDER_ID the same way Telnyx's
// handleRecording() does — recording_url alone used to be stored as-is with
// no Drive copy, which meant the audio was never actually saved anywhere
// this app controls; if Dograh's link is as short-lived as Telnyx's S3 links
// (or gets cleaned up on Dograh's end), that recording is gone for good. The
// copy runs before the lock, same reasoning as handleRecording(): the fetch
// and upload take seconds and shouldn't hold the lock that long.
function handleDograhNotetaker(captureId, body) {
  var recordingUrl = body.recording_url || ''
  // Per-call artifact folder (see transcription.js). It is created here, before
  // the claim is known, so it is named "unmatched" until stage A renames it.
  // Drive trouble here must never cost us the webhook, so it degrades to null
  // and every consumer falls back to the flat RECORDINGS_FOLDER_ID.
  var callFolder = tryGetCallFolder({ capture_id: captureId, call_started_at: body.call_time })
  var audioDriveId = recordingUrl
    ? copyRecordingToDrive(recordingUrl, captureId, 'wav', callFolder)
    : ''

  return withJobLock(function () {
    var tagSchema = loadEnums()
    var validated = validateLiveFields(body, tagSchema, 'dograh')
    var transcript = fetchDograhTranscript(body.transcript_url)

    tryWriteCallArtifacts(callFolder, captureId, body, transcript, audioDriveId)

    // The transcription columns postdate every Jobs sheet in existence and
    // writeRowFields throws on a header it can't find, so they have to exist
    // before call_folder_id below is written into an already-present row.
    ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)
    ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)

    upsertJob(captureId, {
      source: 'dograh',
      call_folder_id: callFolder ? callFolder.getId() : '',
      call_disposition: body.call_disposition || '',
      duration_sec: Number(body.duration_sec) || '',
      call_started_at: body.call_time || '',
      call_ended_at: new Date().toISOString(),
      recording_url: recordingUrl,
      audio_drive_id: audioDriveId,
      transcript: transcript.slice(0, 45000),
      transcript_source: 'dograh-notetaker',
      transcript_chars: transcript.length,
      live_fields: JSON.stringify(body),
      live_fields_validated: JSON.stringify(validated),
      live_fields_source: 'dograh',
      status: 'pending',
    })

    return ContentService.createTextOutput('OK')
  })
}

// Companion to handleDograhNotetaker above, for a call that never fired a real
// webhook: the transcript and recording only exist as files on whoever's disk
// downloaded them from the Dograh dashboard. Same Jobs-sheet shape (source:
// 'dograh', so the transcription/matching/extraction pipeline treats it exactly
// like a live call) but transcript arrives as raw text and audio as a base64
// body field instead of transcript_url/recording_url, since there is nothing
// UrlFetchApp could fetch for a file that only exists locally.
function handleManualRecordingInject(captureId, body) {
  var transcript = String(body.transcript || '')
  var callFolder = tryGetCallFolder({ capture_id: captureId, call_started_at: body.call_time })
  var audioDriveId = saveBase64AudioToDrive(
    body.audio_base64,
    body.audio_extension || 'wav',
    captureId,
    callFolder,
  )

  return withJobLock(function () {
    tryWriteCallArtifacts(callFolder, captureId, body, transcript, audioDriveId)

    // Same reason handleDograhNotetaker ensures these first: writeRowFields
    // throws on a header it can't find, and these columns postdate every Jobs
    // sheet in existence.
    ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)
    ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)

    upsertJob(captureId, {
      source: 'dograh',
      call_folder_id: callFolder ? callFolder.getId() : '',
      call_disposition: body.call_disposition || '',
      duration_sec: Number(body.duration_sec) || '',
      call_started_at: body.call_time || '',
      call_ended_at: new Date().toISOString(),
      recording_url: '',
      audio_drive_id: audioDriveId,
      transcript: transcript.slice(0, 45000),
      transcript_source: 'manual-test-inject',
      transcript_chars: transcript.length,
      live_fields: JSON.stringify({}),
      live_fields_validated: JSON.stringify({}),
      live_fields_source: 'dograh',
      status: 'pending',
    })

    return ContentService.createTextOutput('OK')
  })
}

// ---------------------------------------------------------------------------
// Retell
// ---------------------------------------------------------------------------

// Retell's X-Retell-Signature header — see docs.retellai.com/features/secure-webhook
// — is "v={unix_ms_timestamp},d={hex_hmac_sha256_digest}", where the digest is
// HMAC-SHA256(raw_body + timestamp, retell_api_key) and the key is the account's
// Retell API key (the one with the "webhook" badge in the Retell dashboard, not
// a separate secret). The Worker proxy hands this value in as
// params.retell_sig (see routeWebhook's 'retell' branch for why it can't be
// read as a header directly).
var RETELL_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000
var RETELL_SIGNATURE_PATTERN = /^v=(\d+),d=([0-9a-f]+)$/i

function verifyRetellSignature(rawSigParam, e) {
  if (!rawSigParam) return { ok: false, reason: 'missing_retell_signature' }

  var match = RETELL_SIGNATURE_PATTERN.exec(rawSigParam)
  if (!match) return { ok: false, reason: 'malformed_retell_signature' }

  var timestamp = match[1]
  var digest = match[2].toLowerCase()
  var age = Date.now() - Number(timestamp)
  if (age < 0 || age > RETELL_SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: 'stale_retell_signature' }
  }

  var rawBody = (e && e.postData && e.postData.contents) || ''
  var expected = computeRetellSignature(rawBody, timestamp)

  if (constantTimeEquals(digest, expected)) return { ok: true }

  // Diagnostic only — a digest is a one-way HMAC output, not the secret
  // itself, so logging both sides here is safe. Lets us tell a wrong/stale
  // RETELL_API_KEY (digests differ) apart from a raw-body transport issue
  // (raw_body_length would be the tell) without ever seeing the key.
  // key_preview/key_length are 4+4 characters and a count, not enough to
  // reconstruct the key, but enough to visually confirm at runtime whether
  // getConfig('RETELL_API_KEY') is really returning what was pasted into
  // Script Properties.
  // logEvent (not logServerOnly) so this lands in the Raw sheet — Executions
  // doesn't show doPost's own console.log output for externally-triggered
  // web app calls.
  var apiKey = getConfig('RETELL_API_KEY')
  logEvent('retell.signature_mismatch', {
    expected_digest: expected,
    received_digest: digest,
    timestamp: timestamp,
    raw_body_length: rawBody.length,
    key_length: apiKey.length,
    key_preview: previewSecret(apiKey),
    // Full, untruncated raw body (capped at the same 45000-char Sheet-cell
    // safety margin transcript writes already use) so it can be replayed
    // through an independent local verifier — see scripts/verify-retell-
    // signature.mjs. Temporary: remove once the mismatch is root-caused.
    raw_body: rawBody.slice(0, 45000),
  })

  return { ok: false, reason: 'bad_retell_signature' }
}

// Never returns enough of the value to reconstruct it — just enough for a
// human to visually cross-check against a dashboard.
function previewSecret(value) {
  if (value.length <= 8) return '(too short to preview safely)'
  return value.slice(0, 4) + '...' + value.slice(-4)
}

function computeRetellSignature(rawBody, timestamp) {
  var bytes = Utilities.computeHmacSha256Signature(rawBody + timestamp, getConfig('RETELL_API_KEY'))
  return bytesToHex(bytes)
}

// Utilities.computeHmacSha256Signature returns Java's signed bytes (-128..127),
// same quirk transcription.js's readByte() already masks with & 0xff.
function bytesToHex(bytes) {
  return bytes
    .map(function (byte) {
      var hex = (byte & 0xff).toString(16)
      return hex.length === 1 ? '0' + hex : hex
    })
    .join('')
}

// Apps Script has no built-in constant-time compare (no crypto.timingSafeEqual
// equivalent) — this reduces the obvious timing side channel without claiming
// to be a cryptographically rigorous constant-time comparison.
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false
  var diff = 0
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function retellStartIso(call) {
  return call.start_timestamp ? new Date(Number(call.start_timestamp)).toISOString() : ''
}

function retellDurationSec(call) {
  return call.duration_ms ? Number(call.duration_ms) / 1000 : ''
}

// call_ended: the recording and transcript are ready, but post-call analysis
// (call_analyzed) may not have run yet. Namespaced retell-<call_id> (see
// routeWebhook) so it can never collide with dograh-<workflow_run_id> or a raw
// Telnyx CallSessionId in the same Jobs sheet — same reasoning
// handleDograhNotetaker's comment already documents for its own namespace.
//
// Mirrors handleDograhNotetaker's job-shell creation (tryGetCallFolder,
// copyRecordingToDrive, writeCallArtifact, writeManifest — all reused as-is,
// not duplicated) rather than building a parallel Drive subsystem.
//
// Idempotent regardless of which of the two Retell webhooks arrives first:
// status only becomes 'pending' once this job already carries
// call_analysis_data from a call_analyzed that got here first; otherwise it's
// 'awaiting_analysis', mirroring the existing handleRecording/
// handleTranscription idiom for two independent Telnyx signals.
function handleRetellCallEnded(captureId, call) {
  var recordingUrl = call.recording_url || ''
  var callFolder = tryGetCallFolder({
    capture_id: captureId,
    call_started_at: retellStartIso(call),
  })
  var audioDriveId = recordingUrl
    ? copyRecordingToDrive(recordingUrl, captureId, 'wav', callFolder)
    : ''

  return withJobLock(function () {
    var job = getJobByCaptureId(captureId)
    var transcript = String(call.transcript || '')

    tryWriteRetellCallArtifacts(callFolder, captureId, call, transcript, audioDriveId)
    ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)
    ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)

    upsertJob(captureId, {
      source: 'retell',
      call_folder_id: callFolder ? callFolder.getId() : '',
      duration_sec: retellDurationSec(call),
      call_started_at: retellStartIso(call),
      call_ended_at: new Date().toISOString(),
      recording_url: recordingUrl,
      audio_drive_id: audioDriveId,
      transcript: transcript.slice(0, 45000),
      transcript_source: 'retell-call-ended',
      transcript_chars: transcript.length,
      status: job && job.call_analysis_data ? 'pending' : 'awaiting_analysis',
    })

    return ContentService.createTextOutput('OK')
  })
}

// call_analyzed: post-call analysis and Retell's own extracted dynamic
// variables are ready, but call_ended may not have landed yet (out-of-order
// delivery is possible even though the events are generated in order). Mirror
// image of handleRetellCallEnded's ordering check: 'pending' only once this
// job already carries call_ended_at, else 'awaiting_call_ended'.
function handleRetellCallAnalyzed(captureId, call) {
  return withJobLock(function () {
    ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)

    var job = getJobByCaptureId(captureId)
    var tagSchema = loadEnums()
    var dynamicVariables = call.collected_dynamic_variables || {}
    var validated = validateLiveFields(dynamicVariables, tagSchema, 'retell')

    upsertJob(captureId, {
      source: 'retell',
      live_fields: JSON.stringify(dynamicVariables),
      live_fields_validated: JSON.stringify(validated),
      live_fields_source: 'retell',
      call_analysis_data: JSON.stringify(call.call_analysis || {}),
      status: job && job.call_ended_at ? 'pending' : 'awaiting_call_ended',
    })

    return ContentService.createTextOutput('OK')
  })
}

// Companion to tryWriteCallArtifacts (Dograh's version) — same Drive helpers
// (writeCallArtifact, writeManifest), Retell's own field names and filenames.
// transcript_object (per-word timings) is only written when Retell actually
// sent one — call_analyzed's payload may not carry it.
function tryWriteRetellCallArtifacts(folder, captureId, call, transcript, audioDriveId) {
  if (!folder) return

  try {
    if (transcript) writeCallArtifact(folder, 'transcript-retell.txt', transcript)

    if (call.transcript_object && call.transcript_object.length) {
      writeCallArtifact(
        folder,
        'transcript-retell-words.json',
        JSON.stringify(call.transcript_object),
      )
    }

    writeManifest(folder, {
      capture_id: captureId,
      source: 'retell',
      created_at: new Date().toISOString(),
      call_started_at: retellStartIso(call),
      duration_sec: retellDurationSec(call),
      recording_url: call.recording_url || '',
      audio_drive_id: audioDriveId,
      transcript_chars: transcript.length,
      runs: [],
    })
  } catch (err) {
    logEvent('retell.call_artifacts_failed', { capture_id: captureId, error: String(err) })
  }
}

// Mirrors copyRecordingToDrive's folder-selection rule (the per-call folder
// when one exists, else the flat RECORDINGS_FOLDER_ID keyed by capture ID) but
// decodes a base64 body field instead of fetching a URL.
function saveBase64AudioToDrive(audioBase64, extension, captureId, callFolder) {
  var bytes = Utilities.base64Decode(audioBase64)
  var fileName = (callFolder ? 'audio' : captureId) + '.' + extension
  var blob = Utilities.newBlob(bytes, 'audio/' + extension, fileName)
  var folder = callFolder || DriveApp.getFolderById(getConfig('RECORDINGS_FOLDER_ID'))
  return folder.createFile(blob).getId()
}

function tryGetCallFolder(job) {
  try {
    return getOrCreateCallFolder(job, null)
  } catch (err) {
    logEvent('dograh.call_folder_failed', {
      capture_id: job.capture_id,
      error: String(err),
    })
    return null
  }
}

// Everything known at webhook time goes into the folder now, so a call that
// never reaches stage A still leaves an inspectable record behind.
function tryWriteCallArtifacts(folder, captureId, body, transcript, audioDriveId) {
  if (!folder) return

  try {
    if (transcript) writeCallArtifact(folder, 'transcript-dograh.txt', transcript)

    writeManifest(folder, {
      capture_id: captureId,
      source: 'dograh',
      created_at: new Date().toISOString(),
      call_started_at: body.call_time || '',
      duration_sec: Number(body.duration_sec) || 0,
      call_disposition: body.call_disposition || '',
      recording_url: body.recording_url || '',
      audio_drive_id: audioDriveId,
      transcript_chars: transcript.length,
      runs: [],
    })
  } catch (err) {
    logEvent('dograh.call_artifacts_failed', { capture_id: captureId, error: String(err) })
  }
}

// UNCONFIRMED AGAINST A LIVE CALL: Dograh's docs describe transcript_url only as
// "a public download URL for the call transcript" — the content type isn't
// documented. Handles plain text and, in case it turns out to be a JSON array
// of {role, content} turns (reusing stitchAIGatherMessages() from util.js),
// anything else falls back to the raw response body. Confirm against a real
// Dograh Notetaker call and tighten this once the real shape is known.
function fetchDograhTranscript(url) {
  if (!url) return ''

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true })
  if (response.getResponseCode() !== 200) {
    logEvent('dograh.transcript_fetch_failed', { status: response.getResponseCode() })
    return ''
  }

  var text = response.getContentText()
  var parsed = tryJsonParse(text)
  if (parsed && parsed.length && parsed[0] && typeof parsed[0] === 'object') {
    return stitchAIGatherMessages(text)
  }
  return text
}

// A claim only counts as "the one they probably just finished" within a few
// hours of its appt_end — otherwise a quiet day with nothing recently synced
// would keep suggesting a claim from two days ago forever.
var PRE_CALL_SUGGESTION_WINDOW_HOURS = 6

// Candidates cast a wider net than the suggestion itself, since this list is
// what the live agent falls back to for closest-match reasoning when the
// caller says the suggestion is wrong — narrower than the suggestion window,
// but still bounded so the prompt stays short.
var PRE_CALL_CANDIDATE_WINDOW_HOURS = 12
var PRE_CALL_CANDIDATE_LIMIT = 15

// Shared by both voice platforms' pre-connect hooks (handleDograhPreCall and
// handleRetellInbound below) — the only thing that differs between them is
// how this result gets wrapped and typed for each platform's own webhook
// contract. Always returns every suggested_* key, defaulted to '' when
// there's no suggestion, rather than omitting them: Retell's dynamic_variables
// speak a referenced-but-missing key's {{template}} placeholder literally
// (confirmed against Retell's dynamic-variables docs — see spec 015), so a
// key that's merely absent is a real defect there, not a harmless omission.
// Does not catch errors itself — each platform handler's own try/catch keeps
// its own failure-log event name (dograh_pre_call.failed vs.
// retell_inbound.failed) and its own "degrade to no-suggestion" fallback.
function buildClaimSuggestionContext() {
  var now = new Date()
  var claims = getCachedClaims()
  var suggestion = pickMostRecentlyCompletedClaim(claims, now)
  var candidatesText = formatClaimsCandidates(claims, now)

  return {
    has_claim_suggestion: Boolean(suggestion),
    suggested_insured_last_name: (suggestion && suggestion.insured_last_name) || '',
    suggested_address_line1: (suggestion && suggestion.address_line1) || '',
    suggested_city: (suggestion && suggestion.city) || '',
    suggested_claim_number: (suggestion && suggestion.claim_number) || '',
    claims_candidates_text: candidatesText,
  }
}

var EMPTY_CLAIM_SUGGESTION_CONTEXT = {
  has_claim_suggestion: false,
  suggested_insured_last_name: '',
  suggested_address_line1: '',
  suggested_city: '',
  suggested_claim_number: '',
  claims_candidates_text: '',
}

// Never throws, never blocks — Dograh's Pre-Call Data Fetch contract is that
// a slow or failing fetch just proceeds without the extra context, so a
// claims-lookup problem here should degrade to no-suggestion, not fail the
// call.
function handleDograhPreCall() {
  try {
    var initialContext = buildClaimSuggestionContext()
    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: initialContext }),
    ).setMimeType(ContentService.MimeType.JSON)
  } catch (err) {
    var described = describeError(err)
    logEvent('dograh_pre_call.failed', { error: described.error, stack: described.stack })
    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: EMPTY_CLAIM_SUGGESTION_CONTEXT }),
    ).setMimeType(ContentService.MimeType.JSON)
  }
}

// Retell's inbound webhook — see spec 015. Same "never throws, never blocks"
// contract as handleDograhPreCall above: Retell retries the webhook up to 3x
// on a failure/timeout before falling back to the number's default agent, so
// a claims-lookup problem here should degrade to no-suggestion, not eat a
// retry or fail the call.
function handleRetellInbound() {
  try {
    var initialContext = buildClaimSuggestionContext()
    return ContentService.createTextOutput(
      JSON.stringify({
        call_inbound: { dynamic_variables: toRetellDynamicVariables(initialContext) },
      }),
    ).setMimeType(ContentService.MimeType.JSON)
  } catch (err) {
    var described = describeError(err)
    logEvent('retell_inbound.failed', { error: described.error, stack: described.stack })
    return ContentService.createTextOutput(
      JSON.stringify({
        call_inbound: {
          dynamic_variables: toRetellDynamicVariables(EMPTY_CLAIM_SUGGESTION_CONTEXT),
        },
      }),
    ).setMimeType(ContentService.MimeType.JSON)
  }
}

// Retell requires every dynamic_variables value to be a string — non-strings
// are rejected outright (confirmed against Retell's dynamic-variables docs).
// has_claim_suggestion is the one key buildClaimSuggestionContext() returns
// as a real boolean today (Dograh's initial_context has always taken it as
// one), but stringify any non-string value rather than only booleans, so a
// future numeric/other field never slips through as a raw value.
function toRetellDynamicVariables(context) {
  var out = {}
  Object.keys(context).forEach(function (key) {
    var value = context[key]
    if (value === null || value === undefined) {
      out[key] = ''
      return
    }
    out[key] = typeof value === 'string' ? value : String(value)
  })
  return out
}

function pickMostRecentlyCompletedClaim(claims, now) {
  var completed = (claims || [])
    .filter(function (claim) {
      return Boolean(claim.appt_end)
    })
    .map(function (claim) {
      return { claim: claim, endedAt: new Date(claim.appt_end) }
    })
    .filter(function (entry) {
      var hoursSinceEnd = (now.getTime() - entry.endedAt.getTime()) / (60 * 60 * 1000)
      return hoursSinceEnd >= 0 && hoursSinceEnd <= PRE_CALL_SUGGESTION_WINDOW_HOURS
    })
    .sort(function (a, b) {
      return b.endedAt.getTime() - a.endedAt.getTime()
    })

  return completed[0] ? completed[0].claim : null
}

// Formatted the same way llmMatcher.js's buildLlmMatchPrompt lists candidates
// for its own post-call matching pass — the live agent is doing the same
// "which of these does the caller's answer sound like" reasoning, just live
// on the call instead of after it.
function formatClaimsCandidates(claims, now) {
  var withinWindow = (claims || []).filter(function (claim) {
    var reference = claim.appt_end || claim.appt_start
    if (!reference) return false
    var hoursFromNow = Math.abs(now.getTime() - new Date(reference).getTime()) / (60 * 60 * 1000)
    return hoursFromNow <= PRE_CALL_CANDIDATE_WINDOW_HOURS
  })

  withinWindow.sort(function (a, b) {
    var aRef = new Date(a.appt_end || a.appt_start).getTime()
    var bRef = new Date(b.appt_end || b.appt_start).getTime()
    return bRef - aRef
  })

  return withinWindow
    .slice(0, PRE_CALL_CANDIDATE_LIMIT)
    .map(function (claim) {
      return (
        '- ' +
        (claim.insured_last_name || '') +
        ' | ' +
        (claim.address_line1 || '') +
        ' | ' +
        (claim.city || '') +
        ' | ' +
        (claim.claim_number || '')
      )
    })
    .join('\n')
}

// Apps Script only populates e.parameter from the query string and form-encoded
// bodies — Dograh's webhook node sends a JSON body, so the extracted fields live
// in e.postData.contents instead. Only called for event=dograh_notetaker; every
// other event here stays on the e.parameter path it already used.
function parseJsonBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {}
  var parsed = tryJsonParse(e.postData.contents)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

// Dograh's and Retell's defaults look to be wav, but nothing documents
// whether that can change per workflow/account/agent, so every call site
// passes 'wav' as the fallback while still preferring whatever extension the
// URL itself states, in case a given recording really is something else.
function guessAudioExtension(recordingUrl, fallback) {
  var match = /\.(mp3|wav|m4a|ogg|webm)(\?|$)/i.exec(recordingUrl || '')
  return match ? match[1].toLowerCase() : fallback
}

// callFolder is the per-call artifact folder when one could be created; audio
// lands there as a plainly-named audio.<ext> alongside the call's transcripts.
// Without one (CALL_ARTIFACTS_FOLDER_ID unset) it falls back to the flat
// RECORDINGS_FOLDER_ID keyed by capture ID, exactly as before. Recordings
// already sitting in the flat folder are left where they are — no migration.
function copyRecordingToDrive(recordingUrl, callSessionId, fallbackExtension, callFolder) {
  var response = UrlFetchApp.fetch(recordingUrl, { muteHttpExceptions: true })
  if (response.getResponseCode() !== 200) {
    logEvent('webhook.recording_fetch_failed', {
      capture_id: callSessionId,
      status: response.getResponseCode(),
    })
    return ''
  }

  var folder = callFolder || DriveApp.getFolderById(getConfig('RECORDINGS_FOLDER_ID'))
  var extension = guessAudioExtension(recordingUrl, fallbackExtension || 'wav')
  var fileName = (callFolder ? 'audio' : callSessionId) + '.' + extension
  var file = folder.createFile(response.getBlob().setName(fileName))
  return file.getId()
}
