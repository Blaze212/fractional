// Confirmed against a live Stage 1 call (Raw tab, 2026-08-19): Telnyx sends
// PascalCase field names — CallSessionId, From, RecordingUrl, RecordingDuration,
// RecordingStartTime, TranscriptionText — not the snake_case call_session_id the
// spec's draft assumed. firstParam() still checks multiple candidates per field as
// a hedge, but the confirmed real name is listed first.
//
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
  // completed call — no CallSessionId, no From number, none of the Telnyx call
  // shape the checks below assume — so it has to branch off before them, right
  // after the shared secret check.
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

  var callSessionId = firstParam(params, ['CallSessionId', 'CallSid', 'call_session_id'])
  if (!looksLikeTelnyxCallId(callSessionId)) {
    return denied('bad_call_session_id', callSessionId, 'Bad Request')
  }

  var fromNumber = firstParam(params, ['From', 'from'])
  if (fromNumber && !isAllowedCaller(fromNumber)) {
    return denied('caller_not_allowed', callSessionId, 'Forbidden')
  }

  if (event === 'recording') return accepted(callSessionId, handleRecording(callSessionId, params))
  if (event === 'transcription') {
    return accepted(callSessionId, handleTranscription(callSessionId, params))
  }
  if (event === 'action') return accepted(callSessionId, handleAction())

  // Guided (section-by-section) flow — see guidedFlow.js. Not wired to any
  // live Telnyx number; only reachable if something actually posts one of
  // these event names, same as every other event here.
  if (event === 'guided_start') return accepted(callSessionId, handleGuidedStart(callSessionId))
  if (event === 'guided') return accepted(callSessionId, handleGuidedAction(callSessionId, params))
  if (event === 'guided_recording') {
    return accepted(callSessionId, handleGuidedRecordingStatus(callSessionId, params))
  }
  if (event === 'guided_transcription') {
    return accepted(callSessionId, handleGuidedTranscription(callSessionId, params))
  }

  // AIGather doesn't call its own `action` URL — Telnyx delivers the result as
  // a call.ai_gather.ended-shaped webhook to whatever URL is configured for
  // the account (here, the same URL as the plain call-status callbacks), with
  // no `event` param of our own to key off. Detect it by shape instead.
  //
  // Two different flows can produce this shape: guidedFlow.js's chained
  // sections (guided_state.flow === 'guided', set by handleGuidedStart) and
  // single-stage-aigather.xml's one-turn call, which never writes a
  // guided_state at all. Route on which one this call session actually is —
  // whichever handler runs, it's this event's only ever-reachable path, so
  // getting the routing wrong silently drops the whole call's transcript.
  if (looksLikeAIGatherEnded(params)) {
    if (isGuidedFlowCall(callSessionId)) {
      return accepted(callSessionId, handleGuidedAIGatherEnded(callSessionId, params))
    }
    return accepted(callSessionId, handleSingleAIGatherEnded(callSessionId, params))
  }

  // Telnyx's post-call analysis event (CallStatus: "analyzed") — carries
  // Recordings once a phone number's "record the whole call" toggle is on.
  // Shape-detected the same way as AIGather-ended: no `event` param of our
  // own, delivered to the account-level callback URL. Distinguishable by
  // Recordings+Cost being present with no Messages (AIGather-ended has
  // Messages+ConversationId; this has ConversationId+Recordings+Cost).
  if (looksLikeCallAnalyzed(params)) {
    return accepted(callSessionId, handleCallAnalyzed(callSessionId, params))
  }

  return denied('unknown_event', callSessionId, 'OK')
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

// If Telnyx is ever switched from TeXML form posts to JSON webhooks, e.parameter
// arrives empty and the payload is only in postData. Logging its shape makes that
// misconfiguration obvious instead of looking like a silent field-name mismatch.
function describePostData(e) {
  if (!e || !e.postData) return ''
  return String(e.postData.type || '') + ' ' + String(e.postData.contents || '').slice(0, 1000)
}

// Telnyx sends one recording callback per RecordingSid, and the live calls show two
// per call with different start times — the shorter one begins after the greeting
// and loses the opening seconds. Keep the longest recording and drop the rest,
// otherwise the second callback overwrites the first's audio with worse audio and
// pays for a second Drive copy.
function handleRecording(callSessionId, params) {
  var recordingUrl = firstParam(params, ['RecordingUrl', 'recording_url'])
  var fromNumber = firstParam(params, ['From', 'from'])
  var callStartedAt = firstParam(params, ['RecordingStartTime', 'start_time'])
  var durationSec = Number(firstParam(params, ['RecordingDuration', 'recording_duration'])) || 0

  var known = getJobByCaptureId(callSessionId)
  if (known && known.audio_drive_id && Number(known.duration_sec || 0) >= durationSec) {
    logEvent('webhook.recording_superseded', {
      capture_id: callSessionId,
      kept_duration_sec: Number(known.duration_sec || 0),
      dropped_duration_sec: durationSec,
    })
    return ContentService.createTextOutput('OK')
  }

  // The S3 download and Drive upload take seconds. They run before the lock is
  // taken so a slow recording callback cannot block the transcription callback
  // that is arriving at the same moment.
  var audioDriveId = ''
  if (recordingUrl) {
    audioDriveId = copyRecordingToDrive(recordingUrl, callSessionId, 'mp3')
  }

  return withJobLock(function () {
    var job = getJobByCaptureId(callSessionId)

    upsertJob(callSessionId, {
      from_number: fromNumber || '',
      call_started_at: callStartedAt || '',
      call_ended_at: new Date().toISOString(),
      duration_sec: durationSec || '',
      recording_url: recordingUrl || '',
      audio_drive_id: audioDriveId,
      status: job && job.transcript ? 'pending' : 'awaiting_transcript',
    })

    return ContentService.createTextOutput('OK')
  })
}

function handleTranscription(callSessionId, params) {
  var transcript = firstParam(params, ['TranscriptionText', 'transcription_text'])
  var text = transcript || ''

  return withJobLock(function () {
    var job = getJobByCaptureId(callSessionId)

    upsertJob(callSessionId, {
      transcript: text.slice(0, 45000),
      transcript_source: 'telnyx-deepgram-nova-3',
      transcript_chars: text.length,
      // Never leave the status blank. A blank status is picked up by neither the
      // runner nor promoteStaleAwaitingTranscript, so the job sits forever.
      status: job && job.audio_drive_id ? 'pending' : 'awaiting_recording',
    })

    return ContentService.createTextOutput('OK')
  })
}

// True only for a call session guidedFlow.js's handleGuidedStart already
// initialized (guided_state.flow === 'guided'). A single-stage-aigather.xml
// call never writes a guided_state, so a job with none — or no job row at
// all yet, since this event can be the very first thing that ever creates
// one for a single-stage call — falls through to the single-stage handler.
function isGuidedFlowCall(callSessionId) {
  var job = getJobByCaptureId(callSessionId)
  if (!job || !job.guided_state) return false
  try {
    return JSON.parse(job.guided_state).flow === 'guided'
  } catch (err) {
    return false
  }
}

// single-stage-aigather.xml — see that file's header comment. One AIGather
// verb covers the entire call, so call.ai_gather.ended is this flow's only
// and final event: unlike handleGuidedAIGatherEnded() there is no next
// section to advance to and no guided_state to persist. Finalizes the job
// directly, the same shape handleRecording()/handleTranscription() write for
// the single-shot Record flow, so matcher.js/prompt.js/runner.js need no
// changes to consume it.
function handleSingleAIGatherEnded(callSessionId, params) {
  var conversationTranscript = stitchAIGatherMessages(params.Messages)
  var durationSec = Number(firstParam(params, ['DurationSec'])) || 0

  if (!conversationTranscript) {
    logEvent('single_aigather.no_transcript', {
      capture_id: callSessionId,
      param_names: Object.keys(params).sort().join(','),
    })
  }

  return withJobLock(function () {
    var job = getJobByCaptureId(callSessionId)
    // Appended, not overwritten — handleCallAnalyzed() below can land its own
    // [CALL RECORDING] section into this same job's transcript, in either
    // order, once a call's recording data arrives.
    var transcript = appendTranscriptSection(
      job,
      '[AIGATHER CONVERSATION]\n' + conversationTranscript,
    )

    upsertJob(callSessionId, {
      call_ended_at: new Date().toISOString(),
      duration_sec: durationSec || '',
      transcript: transcript.slice(0, 45000),
      transcript_source: 'telnyx-aigather-single-stage',
      transcript_chars: transcript.length,
      status: 'pending',
    })

    return ContentService.createTextOutput('OK')
  })
}

// CallStatus: "analyzed" — Telnyx's post-call analysis event, carrying
// Recordings once a phone number's "record the whole call" toggle is on.
// Telnyx's public TeXML docs don't describe this payload's shape at all when
// Recordings is non-empty, so this logs the full raw content on every call
// (logServerOnly, not the Raw sheet — this can be large) and only attempts a
// best-effort extraction of an obvious recording URL via firstRecordingUrl().
// Confirm the real shape against a live call with recording genuinely on,
// then tighten firstRecordingUrl() to match — same "confirm against a live
// call, then replace the hedge" pattern this file's top-of-file comment and
// guidedFlow.js's parseAIGatherResult() already followed.
//
// KNOWN GAP: in the one real call observed so far, this event arrived ~14
// minutes after call.ai_gather.ended — almost certainly after runner.js has
// already extracted fields and generated the doc from the AIGather-only
// transcript. This still records the recording URL and appends it to the
// transcript for a human reviewing the job, but does NOT re-trigger
// extraction or regenerate an already-generated doc. Whether a late-arriving
// recording should force re-extraction is an open design question, not
// resolved here — see template/README.md, "Phase 3."
function handleCallAnalyzed(callSessionId, params) {
  logServerOnly('call_analyzed.raw', {
    capture_id: callSessionId,
    recordings: params.Recordings || '',
    conversation_insights: params.ConversationInsights || '',
    cost: params.Cost || '',
  })

  var recordingUrl = firstRecordingUrl(params.Recordings)
  if (!recordingUrl) {
    logEvent('call_analyzed.no_recording', { capture_id: callSessionId })
    return ContentService.createTextOutput('OK')
  }

  logEvent('call_analyzed.recording_found', {
    capture_id: callSessionId,
    recording_url: recordingUrl,
  })

  return withJobLock(function () {
    var job = getJobByCaptureId(callSessionId)
    var transcript = appendTranscriptSection(job, '[CALL RECORDING]\n' + recordingUrl)

    upsertJob(callSessionId, {
      recording_url: recordingUrl,
      transcript: transcript.slice(0, 45000),
      transcript_chars: transcript.length,
    })

    return ContentService.createTextOutput('OK')
  })
}

function appendTranscriptSection(existingJob, section) {
  var existing = (existingJob && existingJob.transcript) || ''
  return existing ? existing + '\n\n' + section : section
}

// Best-effort only — Telnyx's docs don't describe this field's shape. Handles
// a bare array of URL strings and the common {url:...}/{recording_url:...}/
// {download_url:...} object shapes; anything else falls through to '', and
// handleCallAnalyzed()'s raw log is what tells us how to extend this once a
// real payload is seen.
function firstRecordingUrl(raw) {
  var parsed = tryJsonParse(raw)
  if (!parsed || !parsed.length) return ''
  var entry = parsed[0]
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object') {
    return entry.url || entry.recording_url || entry.download_url || ''
  }
  return ''
}

// Shares no fields with looksLikeAIGatherEnded's shape (Messages+ConversationId)
// — this event has Recordings+Cost and no Messages.
function looksLikeCallAnalyzed(params) {
  return Boolean(params.Recordings !== undefined && params.Cost !== undefined && !params.Messages)
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

  return constantTimeEquals(digest, expected)
    ? { ok: true }
    : { ok: false, reason: 'bad_retell_signature' }
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
// documented. Handles plain text and, in case it turns out to be structured the
// same way Telnyx's AIGather result is, a JSON array of {role, content} turns
// (reusing stitchAIGatherMessages() from guidedFlow.js); anything else falls
// back to the raw response body. Confirm against a real Dograh Notetaker call
// and tighten this the same way this file's other hedges already document
// doing (see the top-of-file comment on Telnyx's PascalCase field names).
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

// Never throws, never blocks — Dograh's Pre-Call Data Fetch contract is that
// a slow or failing fetch just proceeds without the extra context, so a
// claims-lookup problem here should degrade to no-suggestion, not fail the
// call.
function handleDograhPreCall() {
  try {
    var now = new Date()
    var claims = getClaims()
    var suggestion = pickMostRecentlyCompletedClaim(claims, now)
    var candidatesText = formatClaimsCandidates(claims, now)

    var initialContext = suggestion
      ? {
          has_claim_suggestion: true,
          suggested_insured_last_name: suggestion.insured_last_name || '',
          suggested_address_line1: suggestion.address_line1 || '',
          suggested_city: suggestion.city || '',
          suggested_claim_number: suggestion.claim_number || '',
          claims_candidates_text: candidatesText,
        }
      : { has_claim_suggestion: false, claims_candidates_text: candidatesText }

    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: initialContext }),
    ).setMimeType(ContentService.MimeType.JSON)
  } catch (err) {
    var described = describeError(err)
    logEvent('dograh_pre_call.failed', { error: described.error, stack: described.stack })
    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: { has_claim_suggestion: false } }),
    ).setMimeType(ContentService.MimeType.JSON)
  }
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

function handleAction() {
  return ContentService.createTextOutput(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  ).setMimeType(ContentService.MimeType.XML)
}

// Telnyx's recordings are always mp3 (TeXML's <Record format="mp3">
// confirms it) — its call site passes 'mp3' as the fallback below, not a
// guess. Dograh's default looks to be wav, but nothing documents whether
// that can change per workflow/account, so its call site passes 'wav' as
// the fallback while still preferring whatever extension the URL itself
// states, in case a given recording really is something else.
function guessAudioExtension(recordingUrl, fallback) {
  var match = /\.(mp3|wav|m4a|ogg|webm)(\?|$)/i.exec(recordingUrl || '')
  return match ? match[1].toLowerCase() : fallback
}

// callFolder is the per-call artifact folder when one could be created; audio
// lands there as a plainly-named audio.<ext> alongside the call's transcripts.
// Without one (Telnyx, or CALL_ARTIFACTS_FOLDER_ID unset) it falls back to the
// flat RECORDINGS_FOLDER_ID keyed by capture ID, exactly as before. Recordings
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
  var extension = guessAudioExtension(recordingUrl, fallbackExtension || 'mp3')
  var fileName = (callFolder ? 'audio' : callSessionId) + '.' + extension
  var file = folder.createFile(response.getBlob().setName(fileName))
  return file.getId()
}

function isAllowedCaller(fromNumber) {
  var allowed = getConfigList('ALLOWED_CALLERS', [])
  return allowed.indexOf(fromNumber) !== -1
}

function looksLikeTelnyxCallId(value) {
  return typeof value === 'string' && value.length >= 8
}

function firstParam(params, names) {
  for (var i = 0; i < names.length; i++) {
    if (params[names[i]]) return params[names[i]]
  }
  return ''
}
