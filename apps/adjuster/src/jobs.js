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

  for (var i = 0; i < data.rows.length; i++) {
    if (data.rows[i].capture_id === captureId) return data.rows[i]
  }

  return null
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
  var rowIndex = sheet.getLastRow() + 1
  var newRow = data.headers.map(function (header) {
    return header in merged ? merged[header] : ''
  })
  sheet.getRange(rowIndex, 1, 1, newRow.length).setValues([newRow])
  return rowIndex
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

function getOldestPendingJob() {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var pending = data.rows.filter(function (row) {
    return row.status === 'pending'
  })

  pending.sort(function (a, b) {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })

  return { sheet: sheet, headers: data.headers, job: pending[0] || null }
}

function reclaimStuckJobs() {
  var sheet = getJobsSpreadsheet().getSheetByName(JOBS_TAB)
  var data = getSheetRows(sheet)
  var now = new Date()

  data.rows.forEach(function (row) {
    var leased =
      row.status === 'matching' || row.status === 'extracting' || row.status === 'generating'
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
    if (row.status !== 'awaiting_transcript') return
    if (new Date(row.created_at) >= cutoff) return

    writeRowFields(sheet, data.headers, row._rowIndex, {
      status: 'pending',
      transcript_source: 'deepgram-direct',
    })
  })
}

function appendRaw(eventType, rawBody) {
  var sheet = getJobsSpreadsheet().getSheetByName(RAW_TAB)
  sheet.appendRow([new Date().toISOString(), eventType, rawBody])
}
