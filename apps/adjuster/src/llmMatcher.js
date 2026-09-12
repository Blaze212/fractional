// Fallback for when matcher.js's deterministic scoring can't find a confident
// claim — a misheard name, a spoken-not-exact address, or a claim number read
// out with digits the transcript garbled. matcher.js stays a pure function
// deliberately (see its header); this is the one place in the match path that
// calls out to an LLM, kept separate so the deterministic core is untouched and
// still trivially testable without network stubs.
//
// docs/specs/022 — the transcript this function receives is already the
// adjuster-only projection resolveClaimMatch() computes (see
// adjusterTurnsOf() in transcription.js), so in the live pipeline there is no
// agent turn left to mistake for evidence. The rules below are defense in
// depth, not the primary mechanism: a transcript whose label vocabulary
// wasn't recognized rides through unprojected, and an adjuster can reject his
// own earlier statement within his own turns ("no, not Maple Street, it's
// Venus Street") without any agent turn being involved at all.
var LLM_MATCH_SYSTEM_PROMPT = [
  'You are matching a phone call transcript to the correct insurance claim from',
  'a short list of candidates scheduled around the same time. Transcription can',
  'mishear names and addresses, and callers describe their own claim in their',
  'own words rather than reading it verbatim. Pick the single claim_id whose',
  'insured name, address, or claim number the transcript actually supports.',
  'If no candidate is a plausible match, return an empty claim_id — never guess.',
  'The transcript is labelled by speaker. An automated intake agent routinely',
  "proposes a claim, address, or contact drawn from a calendar guess — an agent's",
  'own proposal is never evidence, even when it is the only candidate that fits.',
  "Only the adjuster's own words support a match. A value the adjuster rejects,",
  'corrects, or contradicts — his own statement or an agent proposal — is',
  'disqualified even when it is the only candidate that fits: list every such',
  'value, verbatim as it appears in the transcript, in rejected_values. When the',
  'adjuster corrects an earlier statement, the correction supersedes everything',
  'said earlier in the call. Return an empty claim_id in preference to a',
  'candidate resting on a rejected or agent-proposed value.',
].join(' ')

function matchClaimWithLlm(callStartedAt, transcript, claims) {
  var pool = claims || []
  if (pool.length === 0) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  var response = callOpenRouter({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
    messages: [
      { role: 'system', content: LLM_MATCH_SYSTEM_PROMPT },
      { role: 'user', content: buildLlmMatchPrompt(callStartedAt, transcript, pool) },
    ],
    jsonSchema: buildMatchSchema(),
  })

  var claimEntry = response.fields && response.fields.claim_id
  var claimId = claimEntry ? String(claimEntry.value || '').trim() : ''

  if (!claimId) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  var rejectedValues = (response.content && response.content.rejected_values) || []

  // The model only ever sees claim_ids from the candidate list it was given.
  // A claim_id naming one that isn't actually in the pool, or one this same
  // response's own rejected_values disqualifies, is treated the same way: a
  // hallucination and a self-contradiction are both "no match", never a guess.
  var matched = pool.filter(function (claim) {
    return claim.claim_id === claimId && !isClaimRejected(claim, rejectedValues)
  })[0]

  if (!matched) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  return {
    claim_id: claimId,
    match_method: 'llm',
    match_confidence: claimEntry.confidence === 'high' ? 'high' : 'low',
    candidates: [],
  }
}

// buildExtractionSchema()'s fields/unplaced_notes shape is reused verbatim for
// claim_id/reasoning (see the header comment on why this call reuses
// openrouter.js's generic extraction plumbing); rejected_values is the one
// property this call needs that extraction doesn't.
function buildMatchSchema() {
  var schema = buildExtractionSchema({ claim_id: {}, reasoning: {} })
  schema.properties.rejected_values = { type: 'array', items: { type: 'string' } }
  schema.required = schema.required.concat(['rejected_values'])
  return schema
}

// A candidate is disqualified when any of its own identity fields normalizes
// into something the model reported as rejected — matched loosely (either
// string containing the other, after normalizing) so "Maple Street" rejects a
// candidate whose address_line1 is "502 Maple Street" and vice versa.
function isClaimRejected(claim, rejectedValues) {
  if (!rejectedValues || !rejectedValues.length) return false

  return [claim.insured_last_name, claim.address_line1, claim.claim_number].some(function (value) {
    return matchesAnyRejectedValue(value, rejectedValues)
  })
}

function matchesAnyRejectedValue(value, rejectedValues) {
  var normalized = normalizeRejectionText(value)
  if (!normalized) return false

  return rejectedValues.some(function (rejected) {
    var normalizedRejected = normalizeRejectionText(rejected)
    if (!normalizedRejected) return false
    return (
      normalized.indexOf(normalizedRejected) !== -1 || normalizedRejected.indexOf(normalized) !== -1
    )
  })
}

function normalizeRejectionText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function buildLlmMatchPrompt(callStartedAt, transcript, claims) {
  var lines = ['Call started at: ' + callStartedAt, '', 'Candidate claims:']

  claims.forEach(function (claim) {
    lines.push(
      '- claim_id: ' +
        claim.claim_id +
        ' | insured_last_name: ' +
        (claim.insured_last_name || '') +
        ' | address_line1: ' +
        (claim.address_line1 || '') +
        ' | city: ' +
        (claim.city || '') +
        ' | claim_number: ' +
        (claim.claim_number || '') +
        ' | appt_end: ' +
        (claim.appt_end || ''),
    )
  })

  lines.push('', 'Transcript:', renderLabelledTurnsForPrompt(transcript))

  return lines.join('\n')
}

// Labels every non-blank line as an adjuster turn. The transcript reaching
// this function is already adjuster-only in the live pipeline (see the header
// comment above LLM_MATCH_SYSTEM_PROMPT); labelling it explicitly, rather than
// handing the model flat text, is what lets the system prompt's speaker rules
// above refer to "the adjuster's own words" as something visibly marked in
// the prompt rather than an unstated assumption.
function renderLabelledTurnsForPrompt(transcript) {
  return String(transcript || '')
    .split('\n')
    .map(function (line) {
      return line.trim() ? 'Adjuster: ' + line : line
    })
    .join('\n')
}
