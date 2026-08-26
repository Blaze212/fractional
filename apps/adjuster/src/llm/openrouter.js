var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
var OPENROUTER_RETRY_BACKOFF_MS = [5000, 15000]
// Cloud Logging entries cap around 256KB — this is a safety backstop, not a
// working limit; any real extraction response stays well under it. Unlike the
// Sheets-cell-size discipline the rest of this codebase observes for anything
// written to the Raw sheet, the full response/transcript here only ever goes
// to console.log (see logServerOnly in log.js), so it doesn't need the much
// tighter 45,000-char margin the Jobs sheet's transcript column uses.
var SERVER_LOG_TRUNCATE_CHARS = 200000

function extractFields(input) {
  var apiKey = input.apiKey
  var model = input.model
  var fallbacks = input.fallbacks || []
  var prompt = buildPrompt({
    transcript: input.transcript,
    claim: input.claim,
    templateSpec: input.templateSpec,
    glossary: input.glossary,
    phraseBank: input.phraseBank,
    liveExtraction: input.liveExtraction,
    adjusterName: input.adjusterName,
    transcriptSource: input.transcriptSource,
  })

  var response = callOpenRouter({
    apiKey: apiKey,
    model: model,
    fallbacks: fallbacks,
    captureId: input.captureId,
    transcript: input.transcript,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    jsonSchema: buildExtractionSchema(input.templateSpec),
  })

  return response
}

// schemaName and logLabel exist so the master-transcript merge (see
// llm/masterTranscript.js) reuses this function's retry, model-fallback, and
// dual-sink logging instead of duplicating them. Both default to what the
// extraction path already sent, so that path is unchanged.
function callOpenRouter(config) {
  var models = [config.model].concat(config.fallbacks || [])
  var logLabel = config.logLabel || 'openrouter'
  var payload = {
    model: config.model,
    models: models,
    messages: config.messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: config.schemaName || 'extraction',
        strict: true,
        schema: config.jsonSchema,
      },
    },
    // Without require_parameters OpenRouter is free to route to an endpoint that
    // does not support structured outputs, and the request fails on the provider
    // side rather than here. Documented at openrouter.ai/docs/features/structured-outputs.
    provider: { require_parameters: true },
  }

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  }

  var lastResponse = null

  for (var attempt = 0; attempt <= OPENROUTER_RETRY_BACKOFF_MS.length; attempt++) {
    var response = UrlFetchApp.fetch(OPENROUTER_URL, options)
    var status = response.getResponseCode()
    var bodyText = response.getContentText()
    lastResponse = response

    // Full request/response pair for this attempt, together, so a bad extraction
    // (e.g. the model working off a stale schema) can be diagnosed from one log
    // line instead of cross-referencing the Jobs sheet's transcript column
    // against a summary that only ever carried field_count/model/usage. This is
    // the real server log (Apps Script Executions / Cloud Logging) — it does not
    // go to the Raw sheet, which isn't built to hold payloads this size.
    var transcriptText = String(config.transcript || '')
    logServerOnly(logLabel + '.response', {
      capture_id: config.captureId || '',
      attempt: attempt + 1,
      status: status,
      model_requested: config.model,
      transcript: transcriptText.slice(0, SERVER_LOG_TRUNCATE_CHARS),
      response_body: bodyText.slice(0, SERVER_LOG_TRUNCATE_CHARS),
    })

    // Lighter, Sheet-visible trail — a fact that this attempt happened, not its
    // full payload. The Raw sheet is for scanning, not for holding the response.
    logEvent(logLabel + '.response_summary', {
      capture_id: config.captureId || '',
      attempt: attempt + 1,
      status: status,
      model_requested: config.model,
      transcript_chars: transcriptText.length,
      response_chars: bodyText.length,
    })

    if (status === 200) return parseOpenRouterResponse(bodyText)

    var retryable = status === 429 || status >= 500
    var hasBudget = attempt < OPENROUTER_RETRY_BACKOFF_MS.length
    if (retryable && hasBudget) {
      Utilities.sleep(OPENROUTER_RETRY_BACKOFF_MS[attempt])
      continue
    }

    throw new Error('OpenRouter request failed: ' + status + ' ' + bodyText)
  }

  throw new Error('OpenRouter request failed after retries: ' + lastResponse.getResponseCode())
}

function parseOpenRouterResponse(bodyText) {
  var body = JSON.parse(bodyText)
  var choice = body.choices && body.choices[0]

  if (!choice || !choice.message || typeof choice.message.content !== 'string') {
    throw new Error('OpenRouter response missing message content')
  }

  var parsed
  try {
    parsed = JSON.parse(choice.message.content)
  } catch (e) {
    throw new Error('OpenRouter response content was not valid JSON: ' + e.message)
  }

  return {
    fields: parsed.fields || {},
    unplaced_notes: parsed.unplaced_notes || [],
    // The parsed body verbatim, for callers whose schema is not the extraction
    // schema (see llm/masterTranscript.js).
    content: parsed,
    model: body.model,
    usage: {
      input_tokens: body.usage ? body.usage.prompt_tokens : undefined,
      output_tokens: body.usage ? body.usage.completion_tokens : undefined,
    },
  }
}

// strict: true means OpenAI-compatible structured output, which requires every
// object to carry additionalProperties: false and to list every one of its
// properties in required. Omitting either is rejected at request time with
// invalid_json_schema, not degraded silently. value is typed as a string because
// every consumer treats it as one — resolveTagsForDoc stringifies it, and the
// enum and variant checks compare it against string keys.
function buildExtractionSchema(templateSpec) {
  var fieldProperties = {}
  var tags = Object.keys(templateSpec || {})

  tags.forEach(function (tag) {
    fieldProperties[tag] = {
      type: 'object',
      properties: {
        value: { type: 'string' },
        source_span: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['value', 'source_span', 'confidence'],
      additionalProperties: false,
    }
  })

  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties: fieldProperties,
        required: tags,
        additionalProperties: false,
      },
      unplaced_notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['fields', 'unplaced_notes'],
    additionalProperties: false,
  }
}
