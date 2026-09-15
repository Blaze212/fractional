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

// Columns that live on a Claims row for the pipeline's own bookkeeping and mean
// nothing to a human or a model reading the claim. Two separate places have to
// know about them, for related reasons:
//
//   formatClaimBlock (prompt.js) serializes the whole row into the "Claim
//   context" block of the extraction and master-merge prompts, where the model is
//   told to treat that block as the claim's identity. A line reading
//   "property_address_fingerprint: 34-9f8e7d6c" inside an identity block the
//   model compares ADDRESSES against is noise at best and a false
//   claim_identity_mismatch at worst.
//
//   transcriptionInputsFingerprint (transcription.js) keys a cached ASR pass on
//   the claim's content. These four change without changing anything the merge
//   can reason about, and re-buying two ASR passes because a row moved up the
//   sheet would be the very defect docs/specs/027 exists to remove.
//
// Anything added here must be invisible to both prompts AND irrelevant to the
// cache key. A column carrying real meaning belongs in neither list.
var CLAIM_BOOKKEEPING_KEYS = [
  '_rowIndex',
  'calendar_fingerprint',
  'property_address_fingerprint',
  'property_lookup_at',
]

function withoutClaimBookkeeping(claim) {
  if (!claim) return claim

  var trimmed = {}
  Object.keys(claim).forEach(function (key) {
    if (CLAIM_BOOKKEEPING_KEYS.indexOf(key) === -1) trimmed[key] = claim[key]
  })

  return trimmed
}
