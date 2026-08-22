// Matching is identity-first. An adjuster records the note whenever they get a
// moment: in the driveway, at the end of the day, or the next morning. Gating on
// the call timestamp meant a note dictated the next day matched nothing, while a
// note dictated at the right time matched a claim the adjuster never mentioned.
// Time is now one signal among several and can neither create nor veto a match on
// its own.
var TIME_WINDOW_MS = 4 * 60 * 60 * 1000
var AMBIGUOUS_SCORE_DELTA = 15

var SCORE = {
  claim_number: 100,
  insured_last_name: 40,
  street_number: 25,
  street_name: 25,
  city: 10,
  time_proximity: 15,
}

var STREET_ABBREVIATIONS = {
  st: 'street',
  ave: 'avenue',
  dr: 'drive',
  rd: 'road',
  blvd: 'boulevard',
  ln: 'lane',
  ct: 'court',
  pl: 'place',
  ter: 'terrace',
  cir: 'circle',
  pkwy: 'parkway',
}

var NUMBER_WORDS = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
}

function matchClaim(callStartedAt, transcript, claims) {
  var pool = claims || []
  if (pool.length === 0) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  var normalized = normalizeForMatch(transcript || '')
  var digits = normalizeDigits(transcript || '')
  var callTime = new Date(callStartedAt).getTime()

  var scored = pool
    .map(function (claim) {
      return scoreClaim(claim, normalized, digits, callTime)
    })
    .sort(function (a, b) {
      return b.score - a.score
    })

  var top = scored[0]

  // Time proximity carries weight but cannot stand alone. Without at least one
  // identity signal there is nothing tying this dictation to this claim, and a
  // confident-looking wrong match is worse than no match.
  if (identitySignalCount(top) === 0) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  if (isAmbiguous(scored)) {
    return {
      claim_id: top.claim.claim_id,
      match_method: 'ambiguous',
      match_confidence: 'low',
      candidates: scored,
    }
  }

  return {
    claim_id: top.claim.claim_id,
    match_method: methodFor(top),
    match_confidence: confidenceFor(top),
    candidates: scored,
  }
}

function scoreClaim(claim, normalizedTranscript, digitTranscript, callTime) {
  var signals = {}
  var score = 0

  if (matchesClaimNumber(claim.claim_number, digitTranscript)) {
    signals.claim_number = true
    score += SCORE.claim_number
  }

  if (containsValue(normalizedTranscript, claim.insured_last_name)) {
    signals.insured_last_name = true
    score += SCORE.insured_last_name
  }

  if (containsValue(normalizedTranscript, streetNumberOf(claim.address_line1))) {
    signals.street_number = true
    score += SCORE.street_number
  }

  if (containsValue(normalizedTranscript, streetNameOf(claim.address_line1))) {
    signals.street_name = true
    score += SCORE.street_name
  }

  if (containsValue(normalizedTranscript, claim.city)) {
    signals.city = true
    score += SCORE.city
  }

  // Time only adds weight, and only to a claim the transcript already supports or
  // that sits close to the call. It is never enough on its own to beat a claim the
  // adjuster actually named.
  if (isNearInTime(claim.appt_end, callTime)) {
    signals.time_proximity = true
    score += SCORE.time_proximity
  }

  return { claim: claim, claim_id: claim.claim_id, score: score, signals: signals }
}

function methodFor(entry) {
  if (entry.signals.claim_number) return 'claim-number'
  if (identitySignalCount(entry) > 0) return 'identity'
  return 'calendar-nearest'
}

function confidenceFor(entry) {
  if (entry.signals.claim_number) return 'high'
  if (entry.signals.insured_last_name && hasAddressSignal(entry)) return 'high'
  return 'low'
}

function hasAddressSignal(entry) {
  return Boolean(entry.signals.street_number || entry.signals.street_name)
}

function identitySignalCount(entry) {
  return ['claim_number', 'insured_last_name', 'street_number', 'street_name', 'city'].filter(
    function (key) {
      return entry.signals[key]
    },
  ).length
}

function isAmbiguous(scored) {
  if (scored.length < 2) return false
  return scored[0].score - scored[1].score < AMBIGUOUS_SCORE_DELTA
}

function isNearInTime(apptEnd, callTime) {
  var end = new Date(apptEnd).getTime()
  if (isNaN(end) || isNaN(callTime)) return false
  return Math.abs(end - callTime) <= TIME_WINDOW_MS
}

function matchesClaimNumber(claimNumber, digitTranscript) {
  var needle = String(claimNumber || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (needle.length < 4) return false
  return digitTranscript.indexOf(needle) !== -1
}

function containsValue(normalizedTranscript, value) {
  var needle = normalizeForMatch(value || '')
  if (!needle) return false
  return normalizedTranscript.indexOf(needle) !== -1
}

function streetNumberOf(addressLine1) {
  var match = /^\s*(\d+)/.exec(addressLine1 || '')
  return match ? match[1] : ''
}

function streetNameOf(addressLine1) {
  return (addressLine1 || '').replace(/^\s*\d+\s*/, '')
}

// Spoken identifiers arrive as words ("one one two two") or spelled out with
// separators ("C-L-M"). Collapsing both to bare alphanumerics lets a claim number
// match however the adjuster read it out.
function normalizeDigits(value) {
  var words = value.toLowerCase().split(/[^a-z0-9]+/)
  return words
    .map(function (word) {
      return NUMBER_WORDS[word] || word
    })
    .join('')
}

function normalizeForMatch(value) {
  var stripped = (value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return stripped
    .split(' ')
    .map(function (word) {
      return STREET_ABBREVIATIONS[word] || word
    })
    .join(' ')
}
