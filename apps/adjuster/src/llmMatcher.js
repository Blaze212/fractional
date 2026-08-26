// Fallback for when matcher.js's deterministic scoring can't find a confident
// claim — a misheard name, a spoken-not-exact address, or a claim number read
// out with digits the transcript garbled. matcher.js stays a pure function
// deliberately (see its header); this is the one place in the match path that
// calls out to an LLM, kept separate so the deterministic core is untouched and
// still trivially testable without network stubs.
var LLM_MATCH_SYSTEM_PROMPT = [
  'You are matching a phone call transcript to the correct insurance claim from',
  'a short list of candidates scheduled around the same time. Transcription can',
  'mishear names and addresses, and callers describe their own claim in their',
  'own words rather than reading it verbatim. Pick the single claim_id whose',
  'insured name, address, or claim number the transcript actually supports.',
  'If no candidate is a plausible match, return an empty claim_id — never guess.',
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
    jsonSchema: buildExtractionSchema({ claim_id: {}, reasoning: {} }),
  })

  var claimEntry = response.fields && response.fields.claim_id
  var claimId = claimEntry ? String(claimEntry.value || '').trim() : ''

  if (!claimId) {
    return { claim_id: null, match_method: 'none', match_confidence: 'none', candidates: [] }
  }

  // The model only ever sees claim_ids from the candidate list it was given —
  // if it names one that isn't actually in the pool, that's a hallucination,
  // not a match, and is never trusted.
  var matched = pool.filter(function (claim) {
    return claim.claim_id === claimId
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

  lines.push('', 'Transcript:', transcript || '')

  return lines.join('\n')
}
