// Two log sinks, deliberately ordered. console.log runs first: it needs no script
// property, no sheet, and no permission, so it reaches Apps Script Executions and
// Cloud Logging even when the spreadsheet config is wrong. The Raw sheet append
// runs second and is wrapped, because appendRaw() reads JOBS_SHEET_ID and resolves
// the Raw tab — either can throw, and a logging failure must never swallow the log
// line that explains it or take down the request that triggered it.
function logEvent(event, fields) {
  var line
  try {
    line = serializeLog(event, fields)
  } catch (err) {
    line = '{"event":"' + event + '","log_error":"' + String(err) + '"}'
  }

  console.log(line)
  appendRawSafe(event, line)
  return line
}

function serializeLog(event, fields) {
  var payload = { ts: new Date().toISOString(), event: event }
  var source = fields || {}

  // 'event' is the log event name and is not overridable — a field of the same
  // name would silently rename every log line to the value of that field.
  Object.keys(source).forEach(function (key) {
    if (key === 'ts' || key === 'event') return
    payload[key] = source[key]
  })

  return JSON.stringify(payload)
}

function appendRawSafe(event, line) {
  try {
    appendRaw(event, line)
  } catch (err) {
    console.error('raw_sheet_write_failed event=' + event + ' error=' + String(err))
  }
}

function describeError(err) {
  if (!err) return { error: 'unknown' }
  return {
    error: String(err.message || err),
    stack: String(err.stack || '').slice(0, 2000),
  }
}
