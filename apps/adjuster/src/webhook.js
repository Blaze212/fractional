// Telnyx TeXML's exact callback parameter names haven't been confirmed against a live
// call yet (Stage 1 of the spec's test protocol does that). Every raw callback body is
// logged to the Raw tab first, before any parsing, specifically so a field-name mismatch
// here is debuggable rather than a silent no-op. firstParam() tries Telnyx's documented
// name plus the Twilio-compatible name TeXML is modeled on, and takes whichever exists.
function doPost(e) {
  var params = e.parameter
  appendRaw(params.event || 'unknown', JSON.stringify(params))

  if (params.t !== getConfig('WEBHOOK_SECRET')) {
    return ContentService.createTextOutput('Forbidden')
  }

  var callSessionId = firstParam(params, ['call_session_id', 'CallSid'])
  if (!looksLikeTelnyxCallId(callSessionId)) {
    return ContentService.createTextOutput('Bad Request')
  }

  var fromNumber = firstParam(params, ['from', 'From'])
  if (fromNumber && !isAllowedCaller(fromNumber)) {
    return ContentService.createTextOutput('Forbidden')
  }

  if (params.event === 'recording') return handleRecording(callSessionId, params)
  if (params.event === 'transcription') return handleTranscription(callSessionId, params)
  if (params.event === 'action') return handleAction()

  return ContentService.createTextOutput('OK')
}

function handleRecording(callSessionId, params) {
  var recordingUrl = firstParam(params, ['recording_url', 'RecordingUrl'])
  var fromNumber = firstParam(params, ['from', 'From'])
  var callStartedAt = firstParam(params, ['start_time', 'RecordingStartTime'])
  var durationSec = firstParam(params, ['recording_duration', 'RecordingDuration'])

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
  var transcript = firstParam(params, ['transcription_text', 'TranscriptionText'])
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
