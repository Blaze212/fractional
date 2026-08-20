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
      result[tag] = needsInput(label)
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

function needsInput(label) {
  return { valid: false, empty: false, label: label }
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
