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
  logEvent('webhook.ping', {})
  return ContentService.createTextOutput('adjuster-webhook ok')
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

  // Dograh's Pre-Call Data Fetch (Beta Notetaker workflow's Start Call node)
  // POSTs here the instant an inbound call arrives, before the agent speaks —
  // same shared-secret gate as every other event, no CallSessionId yet since
  // the call hasn't been assigned one from our side at this point.
  if (event === 'dograh_pre_call') {
    var preCallBody = parseJsonBody(e)
    var fromNumber = (preCallBody.call_inbound && preCallBody.call_inbound.from_number) || ''
    return accepted('precall:' + fromNumber, handleDograhPreCall())
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

// params.t is the shared secret — never log it. Values are truncated so a long
// transcript cannot push the terminal outcome line out of a readable log entry.
function redactParams(params) {
  var safe = {}
  Object.keys(params).forEach(function (key) {
    if (key === 't') {
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

// Dograh's webhook node payload_template mirrors apps/adjuster/template/enums.json
// 1:1 (see the "Notetaker Export" node on workflow id 10551) — every gathered_context
// field lands in `body` under the exact same tag name validateDograhFields() and
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
  var audioDriveId = recordingUrl ? copyRecordingToDrive(recordingUrl, captureId, 'wav') : ''

  return withJobLock(function () {
    var tagSchema = loadEnums()
    var validated = validateDograhFields(body, tagSchema)
    var transcript = fetchDograhTranscript(body.transcript_url)

    upsertJob(captureId, {
      source: 'dograh',
      call_disposition: body.call_disposition || '',
      duration_sec: Number(body.duration_sec) || '',
      call_started_at: body.call_time || '',
      call_ended_at: new Date().toISOString(),
      recording_url: recordingUrl,
      audio_drive_id: audioDriveId,
      transcript: transcript.slice(0, 45000),
      transcript_source: 'dograh-notetaker',
      transcript_chars: transcript.length,
      dograh_fields: JSON.stringify(body),
      dograh_validated: JSON.stringify(validated),
      status: 'pending',
    })

    return ContentService.createTextOutput('OK')
  })
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

function copyRecordingToDrive(recordingUrl, callSessionId, fallbackExtension) {
  var response = UrlFetchApp.fetch(recordingUrl, { muteHttpExceptions: true })
  if (response.getResponseCode() !== 200) {
    logEvent('webhook.recording_fetch_failed', {
      capture_id: callSessionId,
      status: response.getResponseCode(),
    })
    return ''
  }

  var folder = DriveApp.getFolderById(getConfig('RECORDINGS_FOLDER_ID'))
  var extension = guessAudioExtension(recordingUrl, fallbackExtension || 'mp3')
  var fileName = callSessionId + '.' + extension
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
