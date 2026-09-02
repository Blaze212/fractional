// The Apps Script adapter for core's injected dependencies — the Google-side
// half of the contract stated in core/deps.js and docs/adr/009.
//
// This file is the only place UrlFetchApp, Utilities, and log.js are wired to
// core. Client 2 replaces this file and nothing under core/.

// UrlFetchApp's response object, flattened to core's { status, body, headers }
// shape. muteHttpExceptions is forced on: core reads the status code and
// decides what is retryable, which it cannot do if a non-2xx throws first.
function urlFetchAppRequest(request) {
  var options = {
    method: request.method || 'get',
    headers: request.headers || {},
    muteHttpExceptions: true,
  }

  if (request.contentType) options.contentType = request.contentType
  if (request.payload !== undefined) options.payload = request.payload

  return { url: request.url, options: options }
}

function urlFetchAppResponse(response) {
  if (!response) return null

  return {
    status: response.getResponseCode(),
    body: response.getContentText(),
    headers: typeof response.getAllHeaders === 'function' ? response.getAllHeaders() : {},
  }
}

function coreHttpFetch(request) {
  var prepared = urlFetchAppRequest(request)
  return urlFetchAppResponse(UrlFetchApp.fetch(prepared.url, prepared.options))
}

// fetchAll returns non-2xx as ordinary responses, but a transport error throws
// for the whole batch — which would let one dead vendor take out the other.
// Fall back to sequential calls so each source still gets its own chance.
function coreHttpFetchAll(requests) {
  var prepared = (requests || []).map(urlFetchAppRequest)

  try {
    return {
      responses: UrlFetchApp.fetchAll(
        prepared.map(function (entry) {
          return Object.assign({ url: entry.url }, entry.options)
        }),
      ).map(urlFetchAppResponse),
      mode: 'fetch_all',
    }
  } catch (err) {
    logEvent('transcription.fetch_all_failed', { error: String(err) })

    return {
      responses: (requests || []).map(function (request) {
        try {
          return coreHttpFetch(request)
        } catch (fetchErr) {
          logEvent('transcription.fetch_failed', { url: request.url, error: String(fetchErr) })
          return null
        }
      }),
      mode: 'sequential',
    }
  }
}

// Assembled at each call site rather than held in a module-level var: a
// top-level initialiser that reads a Google service would run on every Apps
// Script cold start, including the ones that never touch the pipeline.
function buildCoreDeps() {
  return {
    fetch: coreHttpFetch,
    fetchAll: coreHttpFetchAll,
    logger: { logEvent: logEvent, logServerOnly: logServerOnly },
    sleep: function (ms) {
      Utilities.sleep(ms)
    },
    base64Encode: function (bytes) {
      return Utilities.base64Encode(bytes)
    },
    stringToBytes: function (text) {
      return Utilities.newBlob(text).getBytes()
    },
  }
}

// Core never reads PropertiesService, and never loads enums.json or
// glossary.json — config, tagSchema, and glossary are arguments at every core
// call site. One builder per site rather than one shared object, because the
// three sites do not agree on what is optional: the extraction and match paths
// require OPENROUTER_API_KEY and fail the job without it, while the
// transcription fan-out treats a missing key as a configuration state and
// carries on with whatever sources are configured. Collapsing them would
// change behaviour on a half-configured deploy.

// The model, its fallbacks, and the key — what every plain OpenRouter call
// needs. Throws on a missing property, which is today's behaviour: an
// extraction or match call with no key configured fails the job rather than
// producing an empty draft that reads as a bad call.
function buildOpenRouterConfig() {
  return {
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
  }
}

function buildExtractionConfig() {
  return Object.assign(buildOpenRouterConfig(), {
    adjusterName: getOptionalConfig('ADJUSTER_NAME', 'Brandon'),
  })
}

// Called from inside mergeIfPossible's try, where getConfig throwing on a
// missing property is caught and degrades the run to a raw fallback transcript
// — the behaviour before core existed.
function buildMergeConfig() {
  return Object.assign(buildExtractionConfig(), {
    model: getOptionalConfig('MASTER_TRANSCRIPT_MODEL', getConfig('OPENROUTER_MODEL')),
  })
}

function buildTranscriptionConfig() {
  return {
    elevenLabsApiKey: getOptionalConfig('ELEVENLABS_API_KEY', ''),
    openRouterApiKey: getOptionalConfig('OPENROUTER_API_KEY', ''),
    adjusterName: getOptionalConfig('ADJUSTER_NAME', 'Brandon'),
  }
}
