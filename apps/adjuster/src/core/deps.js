// What core takes from its host runtime, and the only way it is allowed to
// reach outside itself. See docs/adr/009-adjuster-portable-core-contract.md.
//
//   deps.fetch(request) -> { status, body, headers }
//     request: { url, method, headers, payload, contentType }
//     One round trip, nothing more. Retry and model-fallback stay inside core
//     because they are policy, not I/O.
//
//   deps.fetchAll(requests) -> { responses: [response|null], mode }
//     Optional. The Apps Script adapter maps this to UrlFetchApp.fetchAll so
//     the two ASR calls still go out concurrently. Absent, core issues the
//     same requests one at a time through deps.fetch.
//
//   deps.logger.logEvent(event, fields) / deps.logger.logServerOnly(event, fields)
//     The existing log.js shape. Injected rather than called directly because
//     logEvent() reaches SpreadsheetApp through appendRaw() — a core file
//     calling it would write to a Google Sheet without naming a single Apps
//     Script identifier.
//
//   deps.sleep(ms)
//     Blocking sleep, for retry backoff. Apps Script has no Promise and no
//     async, so the backoff core owns needs a synchronous primitive from the
//     host: Utilities.sleep in Apps Script, Atomics.wait in Node.
//
//   deps.base64Encode(bytes) -> string
//   deps.stringToBytes(text) -> number[]
//     Byte primitives. Apps Script has neither Buffer nor TextEncoder, and
//     hand-rolling UTF-8 here would risk changing the bytes that reach
//     ElevenLabs, so the host supplies both.
//
// Every helper below degrades quietly for the optional deps and throws loudly
// for deps.fetch. A missing HTTP client must never be silently skipped: an
// accidental vendor call in a unit test has to be an error, never a charge,
// and a production call that lost its fetch has to fail the job rather than
// return an empty extraction that reads as a bad call.

function requireCoreFetch(deps) {
  if (!deps || typeof deps.fetch !== 'function') {
    throw new Error('adjuster core: deps.fetch is required, no HTTP client was injected')
  }
  return deps.fetch
}

function coreFetch(deps, request) {
  return requireCoreFetch(deps)(request)
}

// One batch through deps.fetchAll when the host has one, otherwise the same
// requests sequentially. `mode` is recorded in the call manifest, so which of
// the two ran is always readable after the fact.
function coreFetchAll(deps, requests) {
  var send = requireCoreFetch(deps)

  if (deps && typeof deps.fetchAll === 'function') return deps.fetchAll(requests)

  return {
    responses: (requests || []).map(function (request) {
      try {
        return send(request)
      } catch (err) {
        coreLogEvent(deps, 'core.fetch_failed', { url: request.url, error: String(err) })
        return null
      }
    }),
    mode: 'sequential',
  }
}

function coreLogEvent(deps, event, fields) {
  var logger = deps && deps.logger
  if (logger && typeof logger.logEvent === 'function') logger.logEvent(event, fields)
}

function coreLogServerOnly(deps, event, fields) {
  var logger = deps && deps.logger
  if (logger && typeof logger.logServerOnly === 'function') logger.logServerOnly(event, fields)
}

function coreSleep(deps, ms) {
  if (deps && typeof deps.sleep === 'function') deps.sleep(ms)
}

function coreBase64Encode(deps, bytes) {
  if (!deps || typeof deps.base64Encode !== 'function') {
    throw new Error('adjuster core: deps.base64Encode is required to send audio')
  }
  return deps.base64Encode(bytes)
}

function coreStringToBytes(deps, text) {
  if (!deps || typeof deps.stringToBytes !== 'function') {
    throw new Error('adjuster core: deps.stringToBytes is required to build a multipart body')
  }
  return deps.stringToBytes(text)
}

// Core's own copy of log.js's describeError. Duplicated rather than injected
// because it is three lines of pure string handling, and a core file reaching
// for the adapter's copy is exactly the cross-file reference the boundary
// guard exists to reject.
function coreDescribeError(err) {
  if (!err) return { error: 'unknown' }
  return {
    error: String(err.message || err),
    stack: String(err.stack || '').slice(0, 2000),
  }
}
