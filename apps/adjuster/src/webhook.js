// Confirmed against a live Stage 1 call (Raw tab, 2026-08-19): Telnyx sends
// PascalCase field names — CallSessionId, From, RecordingUrl, RecordingDuration,
// RecordingStartTime, TranscriptionText — not the snake_case call_session_id the
// spec's draft assumed. firstParam() still checks multiple candidates per field as
// a hedge, but the confirmed real name is listed first. Every raw callback body is
// logged to the Raw tab before any parsing, so a future field-name drift is
// debuggable rather than a silent no-op.
function doPost(e) {
  var params = e.parameter
  appendRaw(params.event || 'unknown', JSON.stringify(params))

  if (params.t !== getConfig('WEBHOOK_SECRET')) {
    return ContentService.createTextOutput('Forbidden')
  }

  var callSessionId = firstParam(params, ['CallSessionId', 'CallSid', 'call_session_id'])
  if (!looksLikeTelnyxCallId(callSessionId)) {
    return ContentService.createTextOutput('Bad Request')
  }

  var fromNumber = firstParam(params, ['From', 'from'])
  if (fromNumber && !isAllowedCaller(fromNumber)) {
    return ContentService.createTextOutput('Forbidden')
  }

  if (params.event === 'recording') return handleRecording(callSessionId, params)
  if (params.event === 'transcription') return handleTranscription(callSessionId, params)
  if (params.event === 'action') return handleAction()

  return ContentService.createTextOutput('OK')
}

function handleRecording(callSessionId, params) {
  var recordingUrl = firstParam(params, ['RecordingUrl', 'recording_url'])
  var fromNumber = firstParam(params, ['From', 'from'])
  var callStartedAt = firstParam(params, ['RecordingStartTime', 'start_time'])
  var durationSec = firstParam(params, ['RecordingDuration', 'recording_duration'])

  var audioDriveId = ''
  if (recordingUrl) {
    audioDriveId = copyRecordingToDrive(recordingUrl, callSessionId)
  }

  upsertJob(callSessionId, {
    from_number: fromNumber || '',
    call_started_at: callStartedAt || '',
    call_ended_at: new Date().toISOString(),
    duration_sec: durationSec || '',
    recording_url: recordingUrl || '',
    audio_drive_id: audioDriveId,
    status: 'awaiting_transcript',
  })

  return ContentService.createTextOutput('OK')
}

function handleTranscription(callSessionId, params) {
  var transcript = firstParam(params, ['TranscriptionText', 'transcription_text'])
  var text = transcript || ''

  var fields = {
    transcript: text.slice(0, 45000),
    transcript_source: 'telnyx-deepgram-nova-3',
    transcript_chars: text.length,
  }

  var job = getJobByCaptureId(callSessionId)
  if (job && job.audio_drive_id) fields.status = 'pending'

  upsertJob(callSessionId, fields)
  return ContentService.createTextOutput('OK')
}

function handleAction() {
  return ContentService.createTextOutput(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  ).setMimeType(ContentService.MimeType.XML)
}

function copyRecordingToDrive(recordingUrl, callSessionId) {
  var response = UrlFetchApp.fetch(recordingUrl, { muteHttpExceptions: true })
  if (response.getResponseCode() !== 200) return ''

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
