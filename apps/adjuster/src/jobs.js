var JOBS_TAB = 'Jobs'
var CLAIMS_TAB = 'Claims'
var RAW_TAB = 'Raw'

function getJobsSpreadsheet() {
  return SpreadsheetApp.openById(getConfig('JOBS_SHEET_ID'))
}

function getSheetRows(sheet) {
  var values = sheet.getDataRange().getValues()
  var headers = values[0]
  var rows = []

  for (var i = 1; i < values.length; i++) {
    var row = {}
    for (var col = 0; col < headers.length; col++) {
      row[headers[col]] = values[i][col]
    }
    row._rowIndex = i + 1
    rows.push(row)
  }

  return { headers: headers, rows: rows }
}

function findColumnIndex(headers, headerName) {
  var index = headers.indexOf(headerName)
  if (index === -1) throw new Error('Missing column: ' + headerName)
  return index
}

function getJobByCaptureId(captureId) {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)

  var matches = data.rows.filter(function (row) {
    return row.capture_id === captureId
  })

  // A sheet has no unique constraint, so duplicates are always possible: a race,
  // a hand-pasted row, a restored backup. Taking the first match silently is what
  // let duplicate captures go unnoticed for days. Still return the first, so
  // behaviour is unchanged, but say so loudly.
  if (matches.length > 1) {
    logEvent('jobs.duplicate_capture_id', {
      capture_id: captureId,
      row_count: matches.length,
      rows: matches
        .map(function (row) {
          return row._rowIndex
        })
        .join(','),
    })
  }

  return matches[0] || null
}

// Telnyx fires recording, transcription, and call-progress callbacks for one call
// within about a second of each other, and Apps Script runs them as concurrent
// isolates. Every caller that mutates the Jobs tab must hold this lock: without it
// two handlers read the sheet, both miss the other's row, and both insert — or
// worse, both resolve the same insert index and the second full-row write blanks
// the first one's columns. That is how a captured transcript disappears while the
// recording URL survives.
function withJobLock(callback) {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(30000)) throw new Error('Timed out waiting for the job lock')

  try {
    return callback()
  } finally {
    // Sheet writes are buffered and are NOT guaranteed to be visible to another
    // execution just because this one returned. Releasing the lock without
    // flushing lets the next handler read a sheet that is missing the row this
    // one just wrote, and it appends a duplicate instead of merging into it.
    try {
      SpreadsheetApp.flush()
    } catch (err) {
      console.error('sheet_flush_failed error=' + String(err))
    }
    lock.releaseLock()
  }
}

function upsertJob(captureId, fields) {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var now = new Date().toISOString()
  var existing = data.rows.filter(function (row) {
    return row.capture_id === captureId
  })[0]

  var merged = Object.assign({}, fields, { capture_id: captureId, updated_at: now })

  if (existing) {
    writeRowFields(sheet, data.headers, existing._rowIndex, merged)
    return existing._rowIndex
  }

  merged.created_at = now
  var newRow = data.headers.map(function (header) {
    return header in merged ? merged[header] : ''
  })
  // appendRow resolves the target row at write time. getLastRow() + setValues()
  // resolves it at read time, which lets a concurrent insert land on the same row.
  sheet.appendRow(newRow)
  return sheet.getLastRow()
}

function writeRowFields(sheet, headers, rowIndex, fields) {
  Object.keys(fields).forEach(function (key) {
    var col = findColumnIndex(headers, key)
    sheet.getRange(rowIndex, col + 1).setValue(fields[key])
  })
}

function getClaims() {
  var sheet = getJobsSpreadsheet().getSheetByName(CLAIMS_TAB)
  return getSheetRows(sheet).rows
}

// The Claims tab predates calendar sync and may not carry every column it
// writes (appt_start, carrier, calendar_fields). writeRowFields throws on any
// header it can't find, so calendarSync.js calls this once per tick rather
// than depending on someone remembering to add columns by hand before turning
// sync on.
function ensureClaimsColumns(requiredHeaders) {
  var sheet = getJobsSpreadsheet().getSheetByName(CLAIMS_TAB)
  var headers = sheet.getDataRange().getValues()[0] || []

  var missing = requiredHeaders.filter(function (header) {
    return headers.indexOf(header) === -1
  })

  missing.forEach(function (header) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
  })

  return missing
}

// The direct analogue of ensureClaimsColumns above, for the Jobs tab: the
// transcription columns (see JOBS_TRANSCRIPTION_COLUMNS in transcription.js)
// postdate every Jobs sheet in existence, and writeRowFields throws on any
// header it can't find, so this runs at the top of every runner tick rather
// than depending on someone adding columns by hand before the next call lands.
function ensureJobsColumns(requiredHeaders) {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var headers = sheet.getDataRange().getValues()[0] || []

  var missing = requiredHeaders.filter(function (header) {
    return headers.indexOf(header) === -1
  })

  missing.forEach(function (header) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header)
  })

  return missing
}

// claim_id is the calendar event ID when synced from Google Calendar (see
// calendarSync.js), so re-syncing an edited event updates its existing row
// instead of appending a duplicate.
function upsertClaim(claimId, fields) {
  var sheet = getJobsSpreadsheet().getSheetByName(CLAIMS_TAB)
  var data = getSheetRows(sheet)
  var existing = data.rows.filter(function (row) {
    return row.claim_id === claimId
  })[0]

  var merged = Object.assign({}, fields, { claim_id: claimId })

  if (existing) {
    writeRowFields(sheet, data.headers, existing._rowIndex, merged)
    return existing._rowIndex
  }

  var newRow = data.headers.map(function (header) {
    return header in merged ? merged[header] : ''
  })
  sheet.appendRow(newRow)
  return sheet.getLastRow()
}

function getOldestJobByStatus(status) {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var matching = data.rows.filter(function (row) {
    return row.status === status
  })

  matching.sort(function (a, b) {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })

  return { sheet: sheet, headers: data.headers, job: matching[0] || null }
}

function getOldestPendingJob() {
  return getOldestJobByStatus('pending')
}

function reclaimStuckJobs() {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var now = new Date()

  data.rows.forEach(function (row) {
    // 'transcribing' belongs here for the same reason the others do: stage A is
    // the longest-running stage in the pipeline and is the one most likely to
    // hit the 6-minute execution cap. Left off the list, a timed-out stage A
    // would sit in 'transcribing' forever with nothing to return it to pending.
    var leased =
      row.status === 'matching' ||
      row.status === 'transcribing' ||
      row.status === 'extracting' ||
      row.status === 'generating'
    if (!leased || !row.lease_until) return

    if (new Date(row.lease_until) < now) {
      if (Number(row.attempts) >= 3) {
        writeRowFields(sheet, data.headers, row._rowIndex, {
          status: 'failed',
          error: 'Exceeded max attempts after lease expiry',
        })
      } else {
        writeRowFields(sheet, data.headers, row._rowIndex, { status: 'pending', lease_until: '' })
      }
    }
  })
}

function promoteStaleAwaitingTranscript() {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var cutoff = new Date(Date.now() - 15 * 60 * 1000)

  data.rows.forEach(function (row) {
    if (row.status !== 'awaiting_transcript' && row.status !== 'awaiting_recording') return
    if (new Date(row.created_at) >= cutoff) return

    // awaiting_recording already holds a Telnyx transcript — only the audio is
    // missing, so the source stays as recorded rather than being relabelled.
    var fields = { status: 'pending' }
    if (row.status === 'awaiting_transcript') fields.transcript_source = 'deepgram-direct'

    writeRowFields(sheet, data.headers, row._rowIndex, fields)
  })
}

function appendRaw(eventType, rawBody) {
  var sheet = getJobsSpreadsheet().getSheetByName(RAW_TAB)
  sheet.appendRow([new Date().toISOString(), eventType, rawBody])
}
