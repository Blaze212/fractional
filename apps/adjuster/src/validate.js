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

    if (schema.type === 'enum' && (schema.values || []).indexOf(field.value) === -1) {
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

// Dograh's Notetaker workflow (see webhook.js's handleDograhNotetaker) hands back
// a final value per field, extracted live during the call by Dograh's own LLM —
// there is no verbatim span into a transcript the way validateFields() checks
// OpenRouter's output against job.transcript, so that guardrail can't run here.
// Enum/variant fields have a closed set of allowed values, so membership in that
// set is itself a meaningful check; narrative and free-text fields have no such
// check available, so they always route to manual review regardless of what
// Dograh returned, same shape as an unfilled field.
function validateDograhFields(dograhFields, tagSchema) {
  var raw = {}
  Object.keys(tagSchema || {}).forEach(function (tag) {
    var value = (dograhFields || {})[tag]
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

    if (schema.type === 'enum' && (schema.values || []).indexOf(field.value) === -1) {
      result[tag] = needsInput(label)
      return
    }

    if (schema.type === 'variant' && !variantKeyExists(schema.values, field.value)) {
      result[tag] = needsInput(label)
      return
    }

    if (schema.type !== 'enum' && schema.type !== 'variant') {
      result[tag] = needsInput(label)
      return
    }

    result[tag] = {
      valid: true,
      label: label,
      value: field.value,
      source_span: '',
      confidence: 'dograh',
    }
  })

  return result
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
