var CANDIDATE_WINDOW_BEFORE_MS = 4 * 60 * 60 * 1000
var CANDIDATE_WINDOW_AFTER_MS = 30 * 60 * 1000
var AMBIGUOUS_WINDOW_MS = 45 * 60 * 1000

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

function matchClaim(callStartedAt, transcript, claims) {
  var callTime = new Date(callStartedAt).getTime()
  var windowStart = callTime - CANDIDATE_WINDOW_BEFORE_MS
  var windowEnd = callTime + CANDIDATE_WINDOW_AFTER_MS

  var candidates = (claims || []).filter(function (claim) {
    var apptEnd = new Date(claim.appt_end).getTime()
    return apptEnd >= windowStart && apptEnd <= windowEnd
  })

  if (candidates.length === 0) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  candidates = rankByProximity(candidates, callTime)

  if (isAmbiguous(candidates)) {
    return {
      claim_id: candidates[0].claim_id,
      match_method: 'ambiguous',
      match_confidence: 'low',
      candidates: candidates,
    }
  }

  var top = candidates[0]
  var confirmed = confirmCandidate(top, transcript)

  if (confirmed) {
    return {
      claim_id: top.claim_id,
      match_method: 'calendar-exact',
      match_confidence: 'high',
      candidates: candidates,
    }
  }

  return {
    claim_id: top.claim_id,
    match_method: 'calendar-nearest',
    match_confidence: 'low',
    candidates: candidates,
  }
}

function rankByProximity(candidates, callTime) {
  return candidates.slice().sort(function (a, b) {
    var aEnd = new Date(a.appt_end).getTime()
    var bEnd = new Date(b.appt_end).getTime()
    var aBefore = aEnd <= callTime
    var bBefore = bEnd <= callTime
    if (aBefore !== bBefore) return aBefore ? -1 : 1
    return Math.abs(aEnd - callTime) - Math.abs(bEnd - callTime)
  })
}

function isAmbiguous(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    for (var j = i + 1; j < candidates.length; j++) {
      var diff = Math.abs(
        new Date(candidates[i].appt_end).getTime() - new Date(candidates[j].appt_end).getTime(),
      )
      if (diff <= AMBIGUOUS_WINDOW_MS) return true
    }
  }
  return false
}

function confirmCandidate(candidate, transcript) {
  var window = (transcript || '').slice(0, 600)
  var normalized = normalizeForMatch(window)
  var checks = [
    candidate.insured_last_name,
    streetNumberOf(candidate.address_line1),
    streetNameOf(candidate.address_line1),
  ]

  for (var i = 0; i < checks.length; i++) {
    var check = checks[i]
    if (check && normalized.indexOf(normalizeForMatch(check)) !== -1) return true
  }
  return false
}

function streetNumberOf(addressLine1) {
  var match = /^\s*(\d+)/.exec(addressLine1 || '')
  return match ? match[1] : ''
}

function streetNameOf(addressLine1) {
  return (addressLine1 || '').replace(/^\s*\d+\s*/, '')
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
