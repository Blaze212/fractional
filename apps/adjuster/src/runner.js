// Wall-clock budget for one drain pass. Checked BEFORE an iteration starts and
// never during one, so the true worst case is this plus one full stage. Stage A
// is itself bounded by the Apps Script 6-minute execution cap, so an iteration
// starting at 239s can still be killed mid-stage; leaseJob + reclaimStuckJobs
// return that job to pending, which is why an overrun is a cost rather than a
// correctness problem. See docs/specs/024.
var DRAIN_BUDGET_MS = 240 * 1000

// Guard against a job that advances without ever reaching a terminal status,
// which would otherwise spin until the execution cap killed the whole pass.
var DRAIN_ITERATION_CAP = 20

// The n8n-driven entry point (docs/specs/024). Where runPipelineTick advances one
// job by one stage per invocation, this drains the queue inside a wall-clock
// budget, so a call reaches 'done' in a single pass instead of waiting for a
// second tick fifteen minutes later.
//
// reclaimStuckJobs and ensureTranscriptionColumns run ONCE per drain rather than
// once per job: under the every-minute trigger the project paid for both 1440
// times a day to discover nothing had changed.
function drainPipeline() {
  var startedAt = Date.now()
  var drainId = 'drain-' + startedAt

  logEvent('runner.drain_start', { drain_id: drainId })

  var prep = withRunnerLock(5000, function () {
    var reclaimed = reclaimStuckJobs()
    ensureTranscriptionColumns()
    return Number(reclaimed || 0)
  })

  // Another drain is already mid-pass. Overlap is expected and safe (the lease
  // plus per-iteration locking means the two never touch the same job), so this
  // is a no-op exit rather than a failure — ok stays true and n8n stays green.
  if (!prep.acquired) {
    logEvent('runner.drain_skipped', { drain_id: drainId, reason: 'lock_unavailable' })
    return drainResult(drainId, 0, [], 'lock_unavailable', 0, Date.now() - startedAt)
  }

  var reclaimedCount = prep.value
  var advanced = []
  var iterations = 0
  var advancedLast = true
  var stoppedBecause = ''

  for (;;) {
    var decision = shouldContinueDrain({
      startedAtMs: startedAt,
      nowMs: Date.now(),
      iterations: iterations,
      advancedLast: advancedLast,
    })

    if (!decision.continue) {
      stoppedBecause = decision.reason
      break
    }

    // The lock is acquired and released INSIDE each iteration, never held across
    // the loop. withJobLock (jobs.js) takes this same script lock with a 30s
    // tryLock, and every webhook handler that mutates the Jobs tab must hold it.
    // A drain that kept the lock for its whole 4-minute budget would time those
    // handlers out and fail Retell and Dograh ingest for a quarter of every
    // cycle, with nothing in either vendor dashboard to explain it. This is the
    // single most important line of this design — see docs/specs/024.
    var pass = processOldestPendingJob()

    if (pass.reason === 'lock_unavailable') {
      stoppedBecause = 'lock_unavailable'
      break
    }

    // Counts advances, not loop passes: the final pass that finds an empty queue
    // is not an iteration anybody needs to account for, and this keeps
    // iterations === advanced.length so the two halves of the summary agree.
    // It also makes the cap mean what it says — twenty ADVANCES without the
    // queue draining is the spin signature.
    advancedLast = pass.advanced
    if (pass.advanced) {
      iterations += 1
      advanced.push(pass.capture_id + ':' + pass.stage)
    }
  }

  var result = drainResult(
    drainId,
    iterations,
    advanced,
    stoppedBecause,
    reclaimedCount,
    Date.now() - startedAt,
  )

  logEvent('runner.drain_end', {
    drain_id: drainId,
    iterations: iterations,
    advanced: advanced.join(','),
    stopped_because: stoppedBecause,
    reclaimed: reclaimedCount,
    ms: result.ms,
  })

  return result
}

// Pure, so the loop-control decision is testable without Apps Script globals
// (ADR 006's rule). Order matters and is the contract:
//
//   queue_empty     — nothing advanced last iteration, so there is no work left.
//                     Checked first: an empty queue makes the other two moot.
//   budget_exhausted— out of wall clock. Checked BEFORE the cap so that the
//                     legitimate busy-queue case (20 real jobs drained inside
//                     240s) reports the honest reason instead of raising a false
//                     iteration_cap alarm.
//   iteration_cap   — hit 20 iterations WITHOUT exhausting the budget, which is
//                     the signature of a job advancing without ever reaching a
//                     terminal status. This is the one value worth investigating.
function shouldContinueDrain(state) {
  if (!state.advancedLast) return { continue: false, reason: 'queue_empty' }
  if (state.nowMs - state.startedAtMs >= DRAIN_BUDGET_MS) {
    return { continue: false, reason: 'budget_exhausted' }
  }
  if (state.iterations >= DRAIN_ITERATION_CAP) {
    return { continue: false, reason: 'iteration_cap' }
  }
  return { continue: true, reason: '' }
}

function drainResult(drainId, iterations, advanced, stoppedBecause, reclaimed, ms) {
  return {
    ok: true,
    drain_id: drainId,
    iterations: iterations,
    advanced: advanced,
    stopped_because: stoppedBecause,
    reclaimed: reclaimed,
    ms: ms,
  }
}

// One acquire and one release per call — the whole point of the refactor in
// docs/specs/024. Flushes before releasing for the same reason withJobLock
// (jobs.js) does: sheet writes are buffered and are NOT guaranteed to be visible
// to the next execution just because this one returned.
function withRunnerLock(timeoutMs, callback) {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(timeoutMs)) return { acquired: false, value: null }

  try {
    return { acquired: true, value: callback() }
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// The manual single-step entry point. Kept so a one-stage run stays available
// from the Apps Script editor after the every-minute trigger is retired
// (docs/specs/024 phase 3). External behaviour is unchanged: one invocation
// reclaims, ensures columns, and advances exactly one job by exactly one stage.
//
// What changed is the lock. It used to be held across the whole tick and
// inherited by processOldestPendingJob; that function now takes its own, so this
// takes the lock twice briefly rather than once for the duration.
function runPipelineTick() {
  var startedAt = Date.now()

  var prep = withRunnerLock(5000, function () {
    reclaimStuckJobs()
    ensureTranscriptionColumns()
  })

  if (!prep.acquired) {
    logEvent('runner.skipped', { reason: 'lock_unavailable' })
    return
  }

  logEvent('runner.tick_start', {})

  try {
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
  }
}

function ensureTranscriptionColumns() {
  var added = ensureJobsColumns(JOBS_TRANSCRIPTION_COLUMNS)
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
//
// Lock discipline (docs/specs/024): this function acquires and releases the
// script lock ITSELF rather than inheriting an outer one from its caller. That
// is what lets drainPipeline loop without starving webhook ingest — see the
// comment at its call site. Do not hoist the lock back out to the caller.
function processOldestPendingJob() {
  var pass = withRunnerLock(5000, advanceOldestPendingJob)

  if (!pass.acquired) {
    logEvent('runner.skipped', { reason: 'lock_unavailable' })
    return { advanced: false, reason: 'lock_unavailable', capture_id: '', stage: '' }
  }

  return pass.value
}

// The unlocked body. Callers reach it through processOldestPendingJob, which owns
// the lock; nothing else should call it directly.
function advanceOldestPendingJob() {
  var picked = getOldestJobByStatus('transcribed')
  var stage = 'extract'

  if (!picked.job) {
    picked = getOldestPendingJob()
    stage = 'transcribe'
  }

  if (!picked.job) {
    logEvent('runner.no_pending_jobs', {})
    return { advanced: false, reason: 'queue_empty', capture_id: '', stage: '' }
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

  // A stage that threw still counts as advanced: failJob moved the row to
  // pending or failed, so the drain loop has work to re-examine rather than an
  // empty queue. attempts >= 3 terminates the retry, and the iteration cap
  // bounds the pathological case.
  return { advanced: true, reason: '', capture_id: job.capture_id, stage: stage }
}

// Lease length: 7 minutes (docs/specs/024 phase 3). It only has to outlast the
// 6-minute Apps Script execution cap, so the old 10 minutes bought three minutes
// of dead time before a killed job could be reclaimed. Under the every-minute
// trigger that barely showed; with reclaim now running once per 15-minute drain
// it is three minutes added to every recovery.
function leaseJob(sheet, headers, job, status) {
  writeRowFields(sheet, headers, job._rowIndex, {
    status: status,
    lease_until: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
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
//
// Both matchers read adjusterTurnsOf(job.transcript), never the raw transcript
// — see docs/specs/022. An agent's read-back suggestion is real text in
// job.transcript but is never evidence for a match, so it never reaches either
// matcher at all.
function resolveClaimMatch(job, claims) {
  var adjusterTranscript = adjusterTurnsOf(job.transcript)

  logEvent('runner.match_input', {
    capture_id: job.capture_id,
    label_vocabulary: detectLabelVocabulary(job.transcript),
    full_chars: String(job.transcript || '').length,
    adjuster_chars: adjusterTranscript.length,
  })

  var match = matchClaim(job.call_started_at, adjusterTranscript, claims)
  var triggerReason = llmAdjudicationTrigger(match)

  if (triggerReason) {
    try {
      var llmMatch = matchClaimWithLlm(job.call_started_at, adjusterTranscript, claims)
      logEvent('runner.llm_match_attempted', {
        capture_id: job.capture_id,
        deterministic_method: match.match_method,
        trigger_reason: triggerReason,
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

// docs/specs/022 phase 3 — the same shape a rejected read-back suggestion
// produces (an address with no claim number or insured name behind it) is
// also the shape a *correct* address-only mention produces, so a deterministic
// win resting on address alone is sent to the LLM for a second opinion rather
// than trusted outright. matchClaim() always returns candidates sorted
// descending by score (see matcher.js), so candidates[0] is the winner whose
// signals this checks.
function llmAdjudicationTrigger(match) {
  if (match.match_method === 'none' || match.match_method === 'ambiguous') {
    return match.match_method
  }

  var winner = match.candidates && match.candidates[0]
  if (winner && !winner.signals.claim_number && !winner.signals.insured_last_name) {
    return 'address_only'
  }

  return ''
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

  // docs/specs/022 phase 4 — the extractor itself noticed the transcript names
  // a different identity than the matched claim (see buildPrompt()'s
  // claim-context precondition). A wrong-claim draft is the worst failure this
  // product has, so a detected mismatch routes to human review instead of
  // generating a document nobody can trust next to the ones that can be.
  var identityMismatch = extraction.content && extraction.content.claim_identity_mismatch
  if (identityMismatch && identityMismatch.mismatched) {
    logEvent('runner.claim_identity_mismatch', {
      capture_id: job.capture_id,
      claim_id: (claim && claim.claim_id) || '',
      reason: identityMismatch.reason || '',
    })
    upsertJob(job.capture_id, { status: 'needs_review', lease_until: '', error: '' })
    return
  }

  upsertJob(job.capture_id, { status: 'generating', model: extraction.model })

  var result = renderDraftFromExtraction({
    job: job,
    claim: claim,
    tagSchema: tagSchema,
    haystack: input.haystack,
    calendarFields: hints.calendarFields,
    fields: extraction.fields,
    unplacedNotes: extraction.unplaced_notes || [],
  })

  if (result.status === 'failed') {
    logEvent('runner.docgen_failed', { capture_id: job.capture_id, error: result.error })
    failJob(getJobByCaptureId(job.capture_id) || job, result.error)
    return
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
    phraseBank: loadPhraseBank(),
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
