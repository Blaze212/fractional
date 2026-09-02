function validateFields(fields, transcript, tagSchema) {
  var normalizedTranscript = normalizeWhitespace(transcript || '')
  var result = {}

  Object.keys(tagSchema || {}).forEach(function (tag) {
    var schema = tagSchema[tag]
    var field = (fields || {})[tag]
    var label = schema.label || tag

    if (!fieldHasSourceSpan(field)) {
      result[tag] = isRequired(schema, fields) ? needsInput(label) : omitted(label)
      return
    }

    if (!spanExistsInTranscript(field.source_span, normalizedTranscript)) {
      result[tag] = needsInput(label)
      return
    }

    if (schema.type === 'variant' && !variantKeyExists(schema.values, field.value)) {
      result[tag] = needsInput(label)
      return
    }

    if (field.confidence === 'low') {
      // The span passed spanExistsInTranscript above, so this is real (if
      // garbled) transcript text, not a hallucination — worth surfacing to
      // the adjuster as a "heard" hint even though the field itself needs
      // his input, unlike the no-span/fabricated-span cases above.
      result[tag] = needsInput(label, field.source_span)
      return
    }

    result[tag] = {
      valid: true,
      label: label,
      value: field.value,
      source_span: field.source_span,
      confidence: field.confidence,
    }
  })

  return result
}

// Dograh's Notetaker workflow (see webhook.js's handleDograhNotetaker) and
// Retell's post-call analysis (see webhook.js's handleRetellCallAnalyzed) both
// hand back a final value per field, extracted live during the call by the
// platform's own LLM — there is no verbatim span into a transcript the way
// validateFields() checks OpenRouter's output against job.transcript, so that
// guardrail can't run here. A variant field has a closed set of allowed keys,
// so membership in that set is itself a meaningful check; a field carrying a
// `suggestions` list is the same closed-form low-risk property fact an enum
// used to be (see Architecture decision "suggestions, not enum") and is
// trusted the same way, off-list value or not. Every other narrative and
// free-text field has no such check available, so it always routes to manual
// review regardless of what the platform returned, same shape as an unfilled
// field.
//
// `source` ('dograh' or 'retell') is stamped onto every valid field's
// confidence tier, so a valid field from either platform reads the same way
// downstream as it always has — the rename from validateDograhFields is a
// pure parametrization: calling this with source: 'dograh' reproduces
// validateDograhFields' output byte-for-byte.
function validateLiveFields(rawFields, tagSchema, source) {
  var raw = {}
  Object.keys(tagSchema || {}).forEach(function (tag) {
    var value = (rawFields || {})[tag]
    if (value) raw[tag] = { value: value }
  })

  var result = {}
  Object.keys(tagSchema || {}).forEach(function (tag) {
    var schema = tagSchema[tag]
    var field = raw[tag]
    var label = schema.label || tag

    if (!field) {
      result[tag] = isRequired(schema, raw) ? needsInput(label) : omitted(label)
      return
    }

    if (schema.type === 'variant' && !variantKeyExists(schema.values, field.value)) {
      result[tag] = needsInput(label)
      return
    }

    var isTrusted = schema.type === 'variant' || Array.isArray(schema.suggestions)
    if (!isTrusted) {
      result[tag] = needsInput(label)
      return
    }

    result[tag] = {
      valid: true,
      label: label,
      value: field.value,
      source_span: '',
      confidence: source,
    }
  })

  return result
}

// The transcript-corroboration rule in validateFields is right for narrative
// and behavioral fields — an adjuster's own account of what he saw and did, in
// his own words, where an ungrounded value is a real hallucination risk. It is
// wrong for this small, fixed set of closed-form property facts: a scheduler
// already recorded them before the call, adjusters rarely restate a bedroom
// count or a roof age out loud during dictation, and requiring transcript
// evidence for them just routes them to NEEDS INPUT regardless of what the
// calendar knows — defeating the reason calendar sync exists. For exactly
// these tags, a field validateFields left invalid is filled straight from the
// calendar's raw value instead, unvalidated against the transcript — the same
// trust level validateDograhFields already gives Dograh-only fields. Enum
// fields still enforce set membership; this never reaches narrative fields,
// since they are not in this list.
var CALENDAR_FALLBACK_TAGS = [
  'bedroom_count',
  'bathroom_count',
  'square_footage',
  'year_built',
  'roof_age_years',
  'dwelling_stories',
]

function applyCalendarFallback(validated, calendarFields, tagSchema) {
  CALENDAR_FALLBACK_TAGS.forEach(function (tag) {
    var schema = (tagSchema || {})[tag]
    if (!schema) return

    var current = validated[tag]
    if (current && current.valid) return

    var value = (calendarFields || {})[tag]
    if (!value) return

    validated[tag] = {
      valid: true,
      label: schema.label || tag,
      value: value,
      source_span: '',
      confidence: 'calendar',
    }
  })

  return validated
}

// The second half of the same backstop applyCalendarFallback provides, for the
// same fixed set of closed-form property facts. calendar_fields only carries what
// the scheduler actually typed into the invite description, which on most claims
// is nothing at all — the bed/bath/square-footage/year-built numbers instead come
// from the public-records lookup calendar sync already runs per claim and writes
// to the Claims row (see calendarSync.js's lookupPropertyDetails). Those columns
// existed but were never read back into a report, so these four fields kept
// rendering as NEEDS INPUT on claims where the answer was sitting in the matched
// claim row the whole time. The lookup only reports a value when it can name the
// page it came from (see parsePropertyLookupResponse), which is the check standing
// behind trusting it here.
//
// Runs after applyCalendarFallback, so a value the scheduler typed by hand always
// wins over the looked-up one.
var CLAIM_PROPERTY_FALLBACK_TAGS = {
  year_built: 'property_year_built',
  bedroom_count: 'property_bedrooms',
  bathroom_count: 'property_bathrooms',
  square_footage: 'property_square_footage',
}

function applyClaimPropertyFallback(validated, claim, tagSchema) {
  if (!claim) return validated

  Object.keys(CLAIM_PROPERTY_FALLBACK_TAGS).forEach(function (tag) {
    var schema = (tagSchema || {})[tag]
    if (!schema) return

    var current = validated[tag]
    if (current && current.valid) return

    // Sheet cells come back as numbers as readily as strings (a bare 1978 or
    // 2150), and every consumer downstream treats a field value as a string.
    var raw = claim[CLAIM_PROPERTY_FALLBACK_TAGS[tag]]
    if (raw === undefined || raw === null) return
    var value = String(raw).trim()
    if (!value) return

    validated[tag] = {
      valid: true,
      label: schema.label || tag,
      value: value,
      source_span: '',
      confidence: 'claim',
    }
  })

  return validated
}

// A field carrying a `suggestions` list is advisory, not enforced (see the
// Architecture decision "suggestions, not enum") — an off-list value still
// validates and renders, same as any other string field. This is the signal
// that makes that worth watching: every off-list value is worth surfacing so
// the list can be grown from what adjusters actually say, rather than staying
// a fixed set nobody revisits. Runs as one pass over an already-validated
// result — after validateFields/validateLiveFields and both fallbacks — so
// every entry path is covered from a single place instead of reimplementing
// the check four times.
function collectOffSuggestionFields(validated, tagSchema) {
  var offSuggestion = []

  Object.keys(tagSchema || {}).forEach(function (tag) {
    var schema = tagSchema[tag]
    if (!Array.isArray(schema.suggestions)) return

    var field = (validated || {})[tag]
    if (!field || !field.valid || field.empty) return

    if (schema.suggestions.indexOf(field.value) === -1) {
      offSuggestion.push({ tag: tag, value: field.value, source: field.confidence })
    }
  })

  return offSuggestion
}

// coverage_supporting_detail is meant to add one fact independent of the cause
// or the determination (heat maintained through a freeze, a lapsed policy) —
// but the model sometimes fills it with a restatement of one or both instead,
// which is how a filed coverage paragraph ends up saying the same thing three
// times: cause, "which is covered under the insured's policy", then the
// "supporting" detail repeating either or both. Two detectors below catch that;
// a genuinely independent detail passes through untouched.
//
// When coverage_determination is "unknown", the supporting detail is legitimately
// the reason coverage is in question and may use coverage vocabulary itself (e.g.
// "The policy was in a lapsed status on the date of loss") — only the cause-overlap
// detector applies on that branch, since restating an undetermined coverage call
// isn't the same failure as restating a settled one.
var COVERAGE_DETERMINATION_RESTATEMENT_PATTERNS = [
  /\b(?:is|are|was|were)\s+(?:covered|excluded)\b/i,
  /\bcoverage\s+(?:applies|does not apply|is applicable)\b/i,
  /\bthe claim is (?:covered|denied|excluded)\b/i,
  /\bno coverage concerns\b/i,
]

var COVERAGE_OVERLAP_STOPWORDS = [
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'as',
  'from',
  'due',
]

function coverageContentTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (token) {
      return token && COVERAGE_OVERLAP_STOPWORDS.indexOf(token) === -1
    })
}

// Drop when 60%+ of the cause's own content tokens (stopwords aside) also
// appear in the detail — a genuinely independent fact shares little
// vocabulary with the cause clause it sits beside.
function coverageDetailRestatesCause(detail, cause) {
  var causeTokens = coverageContentTokens(cause)
  if (causeTokens.length === 0) return false

  var detailTokens = coverageContentTokens(detail)
  var overlap = causeTokens.filter(function (token) {
    return detailTokens.indexOf(token) !== -1
  })

  return overlap.length / causeTokens.length >= 0.6
}

function coverageDetailRestatesDetermination(detail) {
  return COVERAGE_DETERMINATION_RESTATEMENT_PATTERNS.some(function (pattern) {
    return pattern.test(detail)
  })
}

function dropCoverageRestatement(validated) {
  var detailField = (validated || {}).coverage_supporting_detail
  if (!detailField || !detailField.valid || detailField.empty) {
    return { validated: validated, dropped: null }
  }

  var detail = String(detailField.value || '')
  var determinationField = (validated || {}).coverage_determination
  var determinationValue =
    determinationField && determinationField.valid && !determinationField.empty
      ? determinationField.value
      : ''
  var causeField = (validated || {}).coverage_cause_narrative
  var causeValue = causeField && causeField.valid && !causeField.empty ? causeField.value : ''

  var restatesCause = coverageDetailRestatesCause(detail, causeValue)
  var restatesDetermination =
    determinationValue !== 'unknown' && coverageDetailRestatesDetermination(detail)

  if (!restatesCause && !restatesDetermination) {
    return { validated: validated, dropped: null }
  }

  var label = detailField.label
  validated.coverage_supporting_detail = omitted(label)

  return { validated: validated, dropped: label + ', as extracted: "' + detail + '"' }
}

// A field can declare requiredWhen: { field, equals } to only be required when a
// sibling field (e.g. roof_status) resolved to a specific value — e.g. roof_covering_type
// is only required when roof_status is "shingle", not when the roof wasn't affected at all.
function isRequired(schema, fields) {
  if (schema.requiredWhen) {
    var sibling = (fields || {})[schema.requiredWhen.field]
    var conditionMet = !!sibling && sibling.value === schema.requiredWhen.equals
    if (!conditionMet) return false
  }
  return schema.required !== false
}

function fieldHasSourceSpan(field) {
  return !!field && typeof field.source_span === 'string' && field.source_span.length > 0
}

function spanExistsInTranscript(sourceSpan, normalizedTranscript) {
  return normalizedTranscript.indexOf(normalizeWhitespace(sourceSpan)) !== -1
}

function needsInput(label, sourceSpan) {
  var result = { valid: false, empty: false, label: label }
  if (sourceSpan) result.source_span = sourceSpan
  return result
}

function omitted(label) {
  return { valid: true, empty: true, label: label }
}

function variantKeyExists(values, key) {
  return (values || []).some(function (option) {
    return option.key === key
  })
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}
