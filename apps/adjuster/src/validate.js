function validateFields(fields, transcript, tagSchema) {
  var normalizedTranscript = normalizeWhitespace(transcript || '')
  var result = {}

  Object.keys(tagSchema || {}).forEach(function (tag) {
    var schema = tagSchema[tag]
    var field = (fields || {})[tag]
    var label = schema.label || tag

    if (!fieldHasSourceSpan(field)) {
      result[tag] = needsInput(label)
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

function fieldHasSourceSpan(field) {
  return !!field && typeof field.source_span === 'string' && field.source_span.length > 0
}

function spanExistsInTranscript(sourceSpan, normalizedTranscript) {
  return normalizedTranscript.indexOf(normalizeWhitespace(sourceSpan)) !== -1
}

function needsInput(label) {
  return { valid: false, label: label }
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}
