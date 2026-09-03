function runPipelineTick() {
  var startedAt = Date.now()
  var lock = LockService.getScriptLock()

  if (!lock.tryLock(5000)) {
    logEvent('runner.skipped', { reason: 'lock_unavailable' })
    return
  }

  logEvent('runner.tick_start', {})

  try {
    reclaimStuckJobs()
    ensureTranscriptionColumns()
    ensureReviewColumns()
    processOldestPendingJob()
    logEvent('runner.tick_end', { ms: Date.now() - startedAt })
  } catch (err) {
    var described = describeError(err)
    logEvent('runner.tick_failed', {
      error: described.error,
      stack: described.stack,
      ms: Date.now() - startedAt,
    })
    throw err
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

function ensureTranscriptionColumns() {
  var added = ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)
  if (added.length > 0) logEvent('runner.jobs_columns_added', { columns: added.join(',') })
}

// Review UI prototype (option A, see docs/specs/012). validated_json holds the
// full validated field map from the last extraction, so finalizeJobReview (see
// reviewUi.js) can re-run generateDoc with the adjuster's decisions overlaid
// without re-extracting or re-validating.
var JOBS_REVIEW_COLUMNS = ['validated_json']

function ensureReviewColumns() {
  var added = ensureJobsColumns(JOBS_REVIEW_COLUMNS)
  if (added.length > 0) logEvent('runner.jobs_columns_added', { columns: added.join(',') })
}

// The pipeline is a two-stage machine driven by status (see docs/specs/012):
// stage A matches the claim and produces the master transcript, stage B extracts
// and generates the doc. Splitting them keeps each Apps Script execution short
// enough for the 6-minute cap — two ASR round-trips plus a long-context merge
// plus extraction plus docgen do not reliably fit in one — and makes each stage
// independently retryable.
//
// One tick advances one job by one stage, and 'transcribed' is preferred over
// 'pending' so work already in flight drains before new work starts.
function processOldestPendingJob() {
  var picked = getOldestJobByStatus('transcribed')
  var stage = 'extract'

  if (!picked.job) {
    picked = getOldestPendingJob()
    stage = 'transcribe'
  }

  if (!picked.job) {
    logEvent('runner.no_pending_jobs', {})
    return
  }

  var job = picked.job
  logEvent('runner.job_leased', {
    capture_id: job.capture_id,
    stage: stage,
    attempt: Number(job.attempts || 0) + 1,
    transcript_chars: Number(job.transcript_chars || 0),
  })

  leaseJob(picked.sheet, picked.headers, job, stage === 'transcribe' ? 'matching' : 'extracting')

  try {
    if (stage === 'transcribe') runTranscriptionStage(job)
    else runExtractionStage(job)
  } catch (e) {
    var described = describeError(e)
    logEvent('runner.job_threw', {
      capture_id: job.capture_id,
      stage: stage,
      error: described.error,
      stack: described.stack,
    })
    failJob(job, e.message)
  }
}

function leaseJob(sheet, headers, job, status) {
  writeRowFields(sheet, headers, job._rowIndex, {
    status: status,
    lease_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: Number(job.attempts || 0) + 1,
    // A new attempt starts clean. Without this the previous attempt's error text
    // survives a successful run and reads as a live failure long after the job
    // reached done.
    error: '',
  })
}

// Stage A. Matching moved here from the old single-stage pipeline because the
// merge call needs claim context, and because the claim's proper nouns are the
// highest-value keyterms to bias both ASR calls with.
//
// The old pipeline wrote a transient 'needs_review' status on an ambiguous match
// and then carried straight on to extraction, overwriting it moments later.
// Status now drives the stage machine, so a job parked there would never be
// picked up again; ambiguity is surfaced by match_method on the sheet and by the
// "Contested" line docgen already puts in the draft's header, as it was before.
function runTranscriptionStage(job) {
  var claims = getClaims()
  var match = resolveClaimMatch(job, claims)

  var claim = match.claim_id
    ? claims.filter(function (c) {
        return c.claim_id === match.claim_id
      })[0]
    : null

  logEvent('runner.matched', {
    capture_id: job.capture_id,
    claim_id: match.claim_id || '',
    match_method: match.match_method,
    match_confidence: match.match_confidence,
    claims_considered: claims.length,
  })

  upsertJob(job.capture_id, {
    claim_id: match.claim_id || '',
    match_method: match.match_method,
    match_confidence: match.match_confidence,
    status: 'transcribing',
  })

  // The job row was read before the match was written, so hand the pass the
  // match it will otherwise record as blank in the call manifest.
  var transcription = runTranscriptionPass(
    Object.assign({}, job, { match_method: match.match_method }),
    claim,
  )

  // attempts resets on a clean stage handoff so stage B gets its own retry
  // budget rather than inheriting whatever stage A spent out of the same 3.
  upsertJob(
    job.capture_id,
    Object.assign({ status: 'transcribed', lease_until: '', attempts: 0 }, transcription),
  )
}

// Deterministic matching can't confirm a claim, or is torn between two —
// fall back to an LLM pass that tolerates misheard names/addresses the exact
// scoring in matcher.js can't. A failed LLM call is logged and the
// deterministic (possibly "none") result stands rather than failing the job.
function resolveClaimMatch(job, claims) {
  var match = matchClaim(job.call_started_at, job.transcript, claims)

  if (match.match_method === 'none' || match.match_method === 'ambiguous') {
    try {
      var llmMatch = matchClaimWithLlm(job.call_started_at, job.transcript, claims)
      logEvent('runner.llm_match_attempted', {
        capture_id: job.capture_id,
        deterministic_method: match.match_method,
        llm_claim_id: llmMatch.claim_id || '',
        llm_confidence: llmMatch.match_confidence,
      })
      if (llmMatch.claim_id) match = llmMatch
    } catch (err) {
      var describedMatchError = describeError(err)
      logEvent('runner.llm_match_failed', {
        capture_id: job.capture_id,
        error: describedMatchError.error,
        stack: describedMatchError.stack,
      })
    }
  }

  return match
}

// Stage B. Its input changed — the master transcript when stage A produced an
// accepted one and the mode is live, otherwise whatever raw source stage A
// resolved to — but its contract did not: extract, validate spans, generate.
function runExtractionStage(job) {
  var claim = findClaimForJob(job)
  var tagSchema = loadEnums()
  var hints = buildExtractionHints(job, claim)

  // Decided in stage A and recorded on the job, so this stage never re-derives
  // it. haystack is the master's turn texts with the speaker labels stripped —
  // see buildSpanHaystack — or simply the transcript itself on any raw path.
  var input = resolveExtractionTranscript(job)

  logEvent('runner.extraction_input', {
    capture_id: job.capture_id,
    source: input.source,
    transcript_chars: input.transcript.length,
  })

  var extraction = runFieldExtraction(job, claim, tagSchema, input, hints)

  upsertJob(job.capture_id, { status: 'generating', model: extraction.model })

  var renderOptions = {
    job: job,
    claim: claim,
    tagSchema: tagSchema,
    haystack: input.haystack,
    calendarFields: hints.calendarFields,
    fields: extraction.fields,
    unplacedNotes: extraction.unplaced_notes || [],
  }

  var prepared = computeValidatedFields(renderOptions)
  var reviewItems = buildReviewItems(job.capture_id, prepared.validated, tagSchema)

  // Review UI prototype (option A, see docs/specs/012): a job with anything
  // review-eligible (validate.js's own [NEEDS INPUT]/medium-confidence
  // predicate — see buildReviewItems) parks here instead of generating a doc
  // straight away. reviewUi.js's finalizeJobReview() picks it back up once
  // the adjuster has decided every item.
  if (reviewItems.length > 0) {
    upsertReviewItems(job.capture_id, reviewItems)
    upsertJob(job.capture_id, {
      status: 'needs_review',
      validated_json: JSON.stringify(prepared.validated),
      lease_until: '',
      error: '',
    })
    logEvent('runner.job_needs_review', {
      capture_id: job.capture_id,
      review_item_count: reviewItems.length,
    })
    return
  }

  var latestJob = getJobByCaptureId(job.capture_id) || job
  finalizeDraftGeneration(latestJob, claim, prepared.validated, tagSchema, prepared.unplacedNotes)
}

// Shared by the no-review-needed path above and reviewUi.js's
// finalizeJobReview(), so "generate the doc and mark the job done" has one
// implementation regardless of which path produced the final validated map.
function finalizeDraftGeneration(job, claim, validated, tagSchema, unplacedNotes, docOptions) {
  var result = generateDoc(job, claim, validated, tagSchema, unplacedNotes, docOptions)

  if (result.status === 'failed') {
    logEvent('runner.docgen_failed', { capture_id: job.capture_id, error: result.error })
    failJob(getJobByCaptureId(job.capture_id) || job, result.error)
    return result
  }

  logEvent('runner.job_done', {
    capture_id: job.capture_id,
    doc_url: result.docUrl,
    needs_input_count: result.needsInputCount,
  })

  upsertJob(job.capture_id, {
    status: 'done',
    doc_url: result.docUrl,
    needs_input_count: result.needsInputCount,
    lease_until: '',
    error: '',
  })

  return result
}

// The review-eligibility predicate is docgen.js's own: resolveTagsForDoc
// renders a [NEEDS INPUT] marker or a yellow "needs review" highlight for
// exactly these fields (see its own comment). Filtering on source_span
// presence instead would silently drop the most common NEEDS INPUT case (a
// field the adjuster never mentioned, which carries no span at all) from the
// review UI — see spec 012 Phase 1.
function buildReviewItems(jobId, validated, tagSchema) {
  var items = []

  Object.keys(tagSchema || {}).forEach(function (tag) {
    var field = validated[tag]
    if (!field) return
    if (field.valid && field.confidence !== 'medium') return

    var schema = tagSchema[tag]
    items.push({
      tag: tag,
      label: schema.label || tag,
      section: schema.section || '',
      source_span: field.source_span || '',
      confidence: field.confidence || '',
    })
  })

  return items
}

// The validation half of renderDraftFromExtraction below, split out so the
// review-gating path above can inspect the validated map before deciding
// whether to generate a doc at all. renderDraftFromExtraction keeps its own
// copy inline rather than calling this, so replay.js's contract (always
// generate immediately) never depends on the review-gating path existing.
function computeValidatedFields(options) {
  var job = options.job
  var tagSchema = options.tagSchema

  var validated = validateFields(options.fields, options.haystack, tagSchema)
  validated = applyCalendarFallback(validated, options.calendarFields, tagSchema)
  validated = applyClaimPropertyFallback(validated, options.claim, tagSchema)

  var coverageDrop = dropCoverageRestatement(validated)
  validated = coverageDrop.validated
  var unplacedNotes = options.unplacedNotes || []
  if (coverageDrop.dropped) {
    unplacedNotes = unplacedNotes.concat(coverageDrop.dropped)
    logEvent('docgen.coverage_detail_dropped', {
      capture_id: job.capture_id,
      dropped: coverageDrop.dropped,
    })
  }

  collectOffSuggestionFields(validated, tagSchema).forEach(function (entry) {
    logEvent('extraction.off_suggestion', {
      capture_id: job.capture_id,
      tag: entry.tag,
      value: entry.value,
      source: entry.source,
    })
  })

  logEvent('runner.validated', {
    capture_id: job.capture_id,
    valid: Object.keys(validated).filter(function (t) {
      return validated[t].valid
    }).length,
    needs_input: Object.keys(validated).filter(function (t) {
      return !validated[t].valid
    }).length,
  })

  return { validated: validated, unplacedNotes: unplacedNotes }
}

function findClaimForJob(job) {
  if (!job || !job.claim_id) return null

  return (
    getClaims().filter(function (c) {
      return c.claim_id === job.claim_id
    })[0] || null
  )
}

// The cross-check hints handed to the extractor. Both Dograh's Notetaker export
// (see webhook.js's handleDograhNotetaker) and Retell's post-call analysis (see
// handleRetellCallAnalyzed) hand back a per-field value captured live during the
// call, with no verbatim span into the transcript — without a cross-check pass
// every field outside the small enum/variant set (validateLiveFields' only
// checkable case) would be forced to NEEDS INPUT regardless of what the platform
// actually captured. Feeding it into the OpenRouter pass as a hint (see
// prompt.js's formatLiveExtraction) lets the model re-derive every field from the
// transcript itself, with a real source_span, using the platform's export only to
// know what to listen for. calendar_fields (see calendarSync.js) is the same kind
// of hint sourced from the scheduling note instead of the call — the live export
// wins on overlap since it was captured live during this specific call.
//
// calendarFields rides along in the return because it is needed twice: once as a
// prompt hint, once as validation's fallback source (applyCalendarFallback).
function buildExtractionHints(job, claim) {
  var hasLiveExport = job.source === 'dograh' || job.source === 'retell'
  var liveFields = hasLiveExport ? JSON.parse(job.live_fields || '{}') : {}
  var calendarFields = parseCalendarFields(claim)
  var liveExtraction =
    Object.keys(liveFields).length > 0 || Object.keys(calendarFields).length > 0
      ? Object.assign({}, calendarFields, liveFields)
      : null

  return { calendarFields: calendarFields, liveExtraction: liveExtraction }
}

// The one paid step in the pipeline's second stage. Writes extraction.json to the
// call folder on the way out so the rendering half can be replayed for free
// afterwards — see replay.js for why that artifact exists.
function runFieldExtraction(job, claim, tagSchema, input, hints) {
  var extraction = extractFields({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
    captureId: job.capture_id,
    transcript: input.transcript,
    transcriptSource: input.source,
    claim: claim,
    templateSpec: tagSchema,
    glossary: loadGlossary(),
    phraseBank: [],
    liveExtraction: hints.liveExtraction,
    adjusterName: getOptionalConfig('ADJUSTER_NAME', 'Brandon'),
  })

  logEvent('runner.extracted', {
    capture_id: job.capture_id,
    model: extraction.model,
    field_count: Object.keys(extraction.fields || {}).length,
    unplaced_notes: (extraction.unplaced_notes || []).length,
    live_extraction_fields: hints.liveExtraction ? Object.keys(hints.liveExtraction).length : 0,
  })

  writeExtractionArtifact(job, claim, input, extraction)

  return extraction
}

// Validation and rendering, shared by the live pipeline and by replay.js's entry
// points. A replayed draft has to travel the exact path a live job travels — a
// replay that drifts from production verifies nothing — so the sequence is
// written down once, here, rather than reproduced at each caller.
//
// Backstops in order: applyCalendarFallback fills the fixed set of property facts
// the transcript is unlikely to state from the scheduler's invite note, then
// applyClaimPropertyFallback fills the same facts from the public-records lookup
// on the Claims row. Calendar first, so a hand-typed invite value always wins.
// dropCoverageRestatement runs last, once coverage_determination and
// coverage_cause_narrative have both settled, since it checks the supporting
// detail against them.
function renderDraftFromExtraction(options) {
  var job = options.job
  var tagSchema = options.tagSchema

  var validated = validateFields(options.fields, options.haystack, tagSchema)
  validated = applyCalendarFallback(validated, options.calendarFields, tagSchema)
  validated = applyClaimPropertyFallback(validated, options.claim, tagSchema)

  var coverageDrop = dropCoverageRestatement(validated)
  validated = coverageDrop.validated
  var unplacedNotes = options.unplacedNotes || []
  if (coverageDrop.dropped) {
    unplacedNotes = unplacedNotes.concat(coverageDrop.dropped)
    logEvent('docgen.coverage_detail_dropped', {
      capture_id: job.capture_id,
      dropped: coverageDrop.dropped,
    })
  }

  // Vocabulary signal for the seven suggestions fields (see validate.js's
  // Architecture-decision comment): an off-list value still validates and
  // renders, this only makes it visible for periodic review.
  collectOffSuggestionFields(validated, tagSchema).forEach(function (entry) {
    logEvent('extraction.off_suggestion', {
      capture_id: job.capture_id,
      tag: entry.tag,
      value: entry.value,
      source: entry.source,
    })
  })

  logEvent('runner.validated', {
    capture_id: job.capture_id,
    valid: Object.keys(validated).filter(function (t) {
      return validated[t].valid
    }).length,
    needs_input: Object.keys(validated).filter(function (t) {
      return !validated[t].valid
    }).length,
  })

  var latestJob = getJobByCaptureId(job.capture_id) || job

  return generateDoc(
    latestJob,
    options.claim,
    validated,
    tagSchema,
    unplacedNotes,
    options.docOptions,
  )
}

// A hand-edited Claims row could carry malformed JSON in this cell — that
// should degrade to "no calendar hint" for this job, not fail the whole
// pipeline over a cross-check field that was never load-bearing.
function parseCalendarFields(claim) {
  if (!claim || !claim.calendar_fields) return {}

  try {
    return JSON.parse(claim.calendar_fields)
  } catch (err) {
    logEvent('runner.calendar_fields_unparseable', {
      claim_id: claim.claim_id,
      error: String(err),
    })
    return {}
  }
}

function failJob(job, errorMessage) {
  var attempts = Number(job.attempts || 0)
  var status = attempts >= 3 ? 'failed' : 'pending'

  logEvent('runner.job_failed', {
    capture_id: job.capture_id,
    attempts: attempts,
    next_status: status,
    error: String(errorMessage).slice(0, 1000),
  })

  upsertJob(job.capture_id, { status: status, error: errorMessage })

  if (status === 'failed') notifyJobFailed(job, errorMessage)
}
