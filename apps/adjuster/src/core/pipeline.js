// The pipeline's decisions, in one place: which claim a call belongs to, what
// the extractor is told to cross-check, what the extractor is asked, and which
// of its answers survive validation. See docs/adr/009.
//
// Every function here is a step the adapter may call on its own, and coreRun
// below composes them into the single call the Node harness and the regression
// corpus use. Both paths run the same code. The Apps Script adapter enters at
// the step boundaries rather than through coreRun because its runner is a
// two-stage machine — matching and the merge in one execution, extraction and
// rendering in the next — which is what keeps each execution inside Apps
// Script's six-minute cap.

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Deterministic scoring could not confirm a claim, or was torn between two.
// Stated as its own predicate so the adapter can ask the question without
// owning the answer.
function coreNeedsLlmClaimMatch(match) {
  return match.match_method === 'none' || match.match_method === 'ambiguous'
}

// The LLM fallback and what to do with its answer. Deliberately does not catch:
// the caller wraps this and its own config assembly in one try, because a
// missing script property and a failed vendor call degrade the run the same way
// and are logged as the same event.
//
// `fallback` is the deterministic result, which stands whenever the model
// declines to name a claim.
function coreResolveLlmMatch(input) {
  var deps = input.deps
  var fallback = input.fallback

  var llmMatch = matchClaimWithLlm(
    input.callStartedAt,
    input.transcript,
    input.claims,
    input.config,
    deps,
  )

  coreLogEvent(deps, 'runner.llm_match_attempted', {
    capture_id: input.captureId,
    deterministic_method: fallback.match_method,
    llm_claim_id: llmMatch.claim_id || '',
    llm_confidence: llmMatch.match_confidence,
  })

  return llmMatch.claim_id ? llmMatch : fallback
}

// Both halves together, for a host with no per-call configuration to assemble.
// The Apps Script adapter uses the two above instead, so that its config read
// sits inside the same try as the vendor call.
function coreResolveMatch(input) {
  var match = matchClaim(input.callStartedAt, input.transcript, input.claims)
  if (!coreNeedsLlmClaimMatch(match)) return match

  try {
    return coreResolveLlmMatch(Object.assign({}, input, { fallback: match }))
  } catch (err) {
    var described = coreDescribeError(err)
    coreLogEvent(input.deps, 'runner.llm_match_failed', {
      capture_id: input.captureId,
      error: described.error,
      stack: described.stack,
    })
    return match
  }
}

function coreFindClaim(claims, claimId) {
  if (!claimId) return null

  return (
    (claims || []).filter(function (claim) {
      return claim.claim_id === claimId
    })[0] || null
  )
}

// ---------------------------------------------------------------------------
// Extraction hints
// ---------------------------------------------------------------------------

// A hand-edited Claims row could carry malformed JSON in this cell — that
// should degrade to "no calendar hint" for this job, not fail the whole
// pipeline over a cross-check field that was never load-bearing.
function coreParseCalendarFields(claim, deps) {
  if (!claim || !claim.calendar_fields) return {}

  try {
    return JSON.parse(claim.calendar_fields)
  } catch (err) {
    coreLogEvent(deps, 'runner.calendar_fields_unparseable', {
      claim_id: claim.claim_id,
      error: String(err),
    })
    return {}
  }
}

// The cross-check hints handed to the extractor. Both Dograh's Notetaker export
// and Retell's post-call analysis hand back a per-field value captured live
// during the call, with no verbatim span into the transcript — without a
// cross-check pass every field outside the small enum/variant set
// (validateLiveFields' only checkable case) would be forced to NEEDS INPUT
// regardless of what the platform actually captured. Feeding it into the
// extraction pass as a hint (see prompt.js's formatLiveExtraction) lets the
// model re-derive every field from the transcript itself, with a real
// source_span, using the platform's export only to know what to listen for.
// calendarFields is the same kind of hint sourced from the scheduling note
// instead of the call; the live export wins on overlap since it was captured
// live during this specific call.
//
// calendarFields rides along in the return because it is needed twice: once as
// a prompt hint, once as validation's fallback source (applyCalendarFallback).
function coreBuildExtractionHints(input) {
  var liveFields = input.liveFields || {}
  var calendarFields = input.calendarFields || {}
  var liveExtraction =
    Object.keys(liveFields).length > 0 || Object.keys(calendarFields).length > 0
      ? Object.assign({}, calendarFields, liveFields)
      : null

  return { calendarFields: calendarFields, liveExtraction: liveExtraction }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// The one paid step in the pipeline's second stage. The caller persists the
// result if it wants a free replay later; core does not know what a Drive file
// is.
function coreExtract(input) {
  var deps = input.deps
  var config = input.config || {}

  var extraction = extractFields({
    apiKey: config.apiKey,
    model: config.model,
    fallbacks: config.fallbacks || [],
    deps: deps,
    captureId: input.captureId,
    transcript: input.transcript,
    transcriptSource: input.transcriptSource,
    claim: input.claim,
    templateSpec: input.tagSchema,
    glossary: input.glossary || [],
    phraseBank: input.phraseBank || [],
    liveExtraction: input.liveExtraction,
    adjusterName: config.adjusterName,
  })

  coreLogEvent(deps, 'runner.extracted', {
    capture_id: input.captureId,
    model: extraction.model,
    field_count: Object.keys(extraction.fields || {}).length,
    unplaced_notes: (extraction.unplaced_notes || []).length,
    live_extraction_fields: input.liveExtraction ? Object.keys(input.liveExtraction).length : 0,
  })

  return extraction
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validation and its backstops, in order. A replayed draft has to travel the
// exact path a live job travels — a replay that drifts from production verifies
// nothing — so the sequence is written down once, here, rather than reproduced
// at each caller.
//
// Backstops in order: applyCalendarFallback fills the fixed set of property
// facts the transcript is unlikely to state from the scheduler's invite note,
// then applyClaimPropertyFallback fills the same facts from the public-records
// lookup on the Claims row. Calendar first, so a hand-typed invite value always
// wins. dropCoverageRestatement runs last, once coverage_determination and
// coverage_cause_narrative have both settled, since it checks the supporting
// detail against them.
//
// Returns the field map the renderer draws from, plus the notes list the
// coverage drop may have added to.
function coreValidate(input) {
  var deps = input.deps
  var tagSchema = input.tagSchema

  var validated = validateFields(input.fields, input.haystack, tagSchema)
  validated = applyCalendarFallback(validated, input.calendarFields, tagSchema)
  validated = applyClaimPropertyFallback(validated, input.claim, tagSchema)

  var coverageDrop = dropCoverageRestatement(validated)
  validated = coverageDrop.validated

  var unplacedNotes = input.unplacedNotes || []
  if (coverageDrop.dropped) {
    unplacedNotes = unplacedNotes.concat(coverageDrop.dropped)
    coreLogEvent(deps, 'docgen.coverage_detail_dropped', {
      capture_id: input.captureId,
      dropped: coverageDrop.dropped,
    })
  }

  // Vocabulary signal for the seven suggestions fields (see validate.js's
  // Architecture-decision comment): an off-list value still validates and
  // renders, this only makes it visible for periodic review.
  collectOffSuggestionFields(validated, tagSchema).forEach(function (entry) {
    coreLogEvent(deps, 'extraction.off_suggestion', {
      capture_id: input.captureId,
      tag: entry.tag,
      value: entry.value,
      source: entry.source,
    })
  })

  coreLogEvent(deps, 'runner.validated', {
    capture_id: input.captureId,
    valid: Object.keys(validated).filter(function (tag) {
      return validated[tag].valid
    }).length,
    needs_input: Object.keys(validated).filter(function (tag) {
      return !validated[tag].valid
    }).length,
  })

  return { validated: validated, unplacedNotes: unplacedNotes }
}

// ---------------------------------------------------------------------------
// core.run
// ---------------------------------------------------------------------------

// Which transcript the extractor reads, and which text a source_span has to
// appear in. The master's speaker labels are stripped from the haystack: a span
// must be evidence the adjuster actually spoke, and a label the merge model
// added is not.
function coreResolveExtractionInput(master, fallback) {
  if (master && master.accepted && master.text) {
    return {
      source: 'master',
      transcript: master.text,
      haystack: buildSpanHaystack(master.text),
    }
  }

  return { source: fallback.source, transcript: fallback.text, haystack: fallback.text }
}

// The whole pipeline in one call, for a host with no six-minute execution cap:
// the Node harness, the regression corpus, and any client 2 runtime that wants
// it. Takes transcripts, returns decisions. Nothing it returns is a Drive file,
// a Doc, or a Sheet row — producing those is the adapter's job.
//
//   input: { sources, claim, claims, tagSchema, glossary, liveFields,
//            precedence, callStartedAt, captureId, config, deps }
//   -> { match, master, extraction, validated, manifest }
function coreRun(input) {
  var deps = input.deps
  var config = input.config || {}
  var sources = input.sources || {}
  var precedence = input.precedence || SOURCE_PRECEDENCE
  var captureId = input.captureId || ''

  var fallback = selectFallbackTranscript(sources, precedence)
  var available = availableSources(sources, precedence)

  // A claim handed in is a claim already matched — a caller replaying a known
  // call should not pay for a match it already knows the answer to.
  var match = input.claim
    ? {
        claim_id: input.claim.claim_id,
        match_method: 'given',
        match_confidence: 'high',
        candidates: [],
      }
    : coreResolveMatch({
        captureId: captureId,
        callStartedAt: input.callStartedAt,
        transcript: fallback.text,
        claims: input.claims || [],
        config: config,
        deps: deps,
      })

  var claim = input.claim || coreFindClaim(input.claims, match.claim_id)

  var master = null
  try {
    master = coreMergeSources({
      captureId: captureId,
      sources: sources,
      available: available,
      precedence: precedence,
      claim: claim,
      glossary: input.glossary,
      config: config,
      deps: deps,
    })
  } catch (err) {
    var describedMerge = coreDescribeError(err)
    coreLogEvent(deps, 'master_transcript.call_failed', {
      capture_id: captureId,
      error: describedMerge.error,
      stack: describedMerge.stack,
    })
  }

  var extractionInput = coreResolveExtractionInput(master, fallback)

  var hints = coreBuildExtractionHints({
    liveFields: input.liveFields,
    calendarFields: coreParseCalendarFields(claim, deps),
  })

  var extraction = coreExtract({
    captureId: captureId,
    transcript: extractionInput.transcript,
    transcriptSource: extractionInput.source,
    claim: claim,
    tagSchema: input.tagSchema,
    glossary: input.glossary,
    liveExtraction: hints.liveExtraction,
    config: config,
    deps: deps,
  })

  var validation = coreValidate({
    captureId: captureId,
    fields: extraction.fields,
    haystack: extractionInput.haystack,
    tagSchema: input.tagSchema,
    claim: claim,
    calendarFields: hints.calendarFields,
    unplacedNotes: extraction.unplaced_notes || [],
    deps: deps,
  })

  return {
    match: match,
    master: master,
    extraction: extraction,
    validated: validation.validated,
    unplacedNotes: validation.unplacedNotes,
    manifest: coreBuildManifest({
      captureId: captureId,
      claim: claim,
      match: match,
      master: master,
      sources: sources,
      precedence: precedence,
      extractionInput: extractionInput.source,
    }),
  }
}

// The per-call audit record, returned rather than written. Same shape the Apps
// Script adapter appends to the Drive manifest, so a run reconstructed from
// core reads the same way as one read out of a call folder.
function coreBuildManifest(input) {
  var master = input.master

  return {
    stage: 'core_run',
    at: new Date().toISOString(),
    capture_id: input.captureId,
    claim_id: (input.claim && input.claim.claim_id) || '',
    match_method: input.match.match_method,
    sources: describeSourcesForManifest(input.sources, input.precedence),
    models: {
      elevenlabs: TRANSCRIPTION_MODELS.elevenlabs.id,
      qwen: TRANSCRIPTION_MODELS.qwen.id,
      merge: master ? master.model : '',
    },
    master_accepted: Boolean(master && master.accepted),
    master_coverage: master ? master.coverage : null,
    contested_passages: master ? master.contested_passages : [],
    failing_shingles: master ? master.failing : [],
    extraction_input: input.extractionInput,
  }
}
