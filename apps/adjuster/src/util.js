function tryJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch (err) {
    return null
  }
}

function stitchAIGatherMessages(raw) {
  var messages = tryJsonParse(raw)
  if (!messages || !messages.length) return ''

  return messages
    .map(function (m) {
      return (m.role === 'assistant' ? 'Q: ' : 'A: ') + m.content
    })
    .join('\n')
}

// A cheap, stable content hash, shared by every "has this input changed since we
// last paid for it?" check in the pipeline — calendar enrichment (docs/specs/027)
// and the transcription pass (ADR 013). Fingerprints are only ever compared,
// never inspected, so any cheap hash will do; a collision would silently suppress
// work that should have re-run, so this pairs two independent 32-bit hashes with
// the input length.
function fingerprintText(text) {
  var value = String(text == null ? '' : text)
  var djb2 = 5381
  var sdbm = 0

  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i)
    djb2 = (djb2 * 33 + code) | 0
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) | 0
  }

  return value.length + '-' + toHex32(djb2) + toHex32(sdbm)
}

function toHex32(n) {
  return ('0000000' + (n >>> 0).toString(16)).slice(-8)
}

// \u0000 cannot occur in any of the fields these fingerprints cover, so no
// rearrangement of the parts can produce the same joined string as a different
// one ("a" + "b" vs "ab" + "").
function fingerprintParts(parts) {
  return fingerprintText(
    (parts || [])
      .map(function (part) {
        return String(part == null ? '' : part)
      })
      .join('\u0000'),
  )
}
