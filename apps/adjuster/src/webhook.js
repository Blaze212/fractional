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
    terminal = routeWebhook(event, params)
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

function routeWebhook(event, params) {
  if (params.t !== getConfig('WEBHOOK_SECRET')) {
    return denied('bad_secret', '', 'Forbidden')
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
    audioDriveId = copyRecordingToDrive(recordingUrl, callSessionId)
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

function handleAction() {
  return ContentService.createTextOutput(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  ).setMimeType(ContentService.MimeType.XML)
}

function copyRecordingToDrive(recordingUrl, callSessionId) {
  var response = UrlFetchApp.fetch(recordingUrl, { muteHttpExceptions: true })
  if (response.getResponseCode() !== 200) {
    logEvent('webhook.recording_fetch_failed', {
      capture_id: callSessionId,
      status: response.getResponseCode(),
    })
    return ''
  }

  var folder = DriveApp.getFolderById(getConfig('RECORDINGS_FOLDER_ID'))
  var file = folder.createFile(response.getBlob().setName(callSessionId + '.mp3'))
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
