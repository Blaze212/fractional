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
    promoteStaleAwaitingTranscript()
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

function processOldestPendingJob() {
  var picked = getOldestPendingJob()

  if (!picked.job) {
    logEvent('runner.no_pending_jobs', {})
    return
  }

  var job = picked.job
  logEvent('runner.job_leased', {
    capture_id: job.capture_id,
    attempt: Number(job.attempts || 0) + 1,
    transcript_chars: Number(job.transcript_chars || 0),
  })

  leaseJob(picked.sheet, picked.headers, job)

  try {
    runJobPipeline(job)
  } catch (e) {
    var described = describeError(e)
    logEvent('runner.job_threw', {
      capture_id: job.capture_id,
      error: described.error,
      stack: described.stack,
    })
    failJob(job, e.message)
  }
}

function leaseJob(sheet, headers, job) {
  writeRowFields(sheet, headers, job._rowIndex, {
    status: 'matching',
    lease_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: Number(job.attempts || 0) + 1,
    // A new attempt starts clean. Without this the previous attempt's error text
    // survives a successful run and reads as a live failure long after the job
    // reached done.
    error: '',
  })
}

function runJobPipeline(job) {
  var claims = getClaims()
  var match = matchClaim(job.call_started_at, job.transcript, claims)

  // Deterministic matching can't confirm a claim, or is torn between two —
  // fall back to an LLM pass that tolerates misheard names/addresses the exact
  // scoring in matcher.js can't. A failed LLM call is logged and the
  // deterministic (possibly "none") result stands rather than failing the job.
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

  var tagSchema = loadEnums()
  var isDograh = job.source === 'dograh'
  // Dograh's Notetaker export (see webhook.js's handleDograhNotetaker) is a
  // per-field value captured live during the call, with no verbatim span into
  // the transcript — it used to skip the OpenRouter pass entirely and go
  // straight to doc generation, which meant every field outside the small
  // enum/variant set (validateDograhFields' only checkable case) was forced to
  // NEEDS INPUT regardless of what Dograh actually captured. Feeding it into
  // the same OpenRouter pass as a cross-check hint (see prompt.js's
  // formatLiveExtraction) lets the model re-derive every field from the
  // transcript itself, with a real source_span, using Dograh's export only to
  // know what to listen for. calendar_fields (see calendarSync.js) is the same
  // kind of hint sourced from the scheduling note instead of the call — Dograh
  // wins on overlap since it was captured live during this specific call.
  var dograhFields = isDograh ? JSON.parse(job.dograh_fields || '{}') : {}
  var calendarFields = parseCalendarFields(claim)
  var liveExtraction =
    Object.keys(dograhFields).length > 0 || Object.keys(calendarFields).length > 0
      ? Object.assign({}, calendarFields, dograhFields)
      : null

  upsertJob(job.capture_id, {
    claim_id: match.claim_id || '',
    match_method: match.match_method,
    match_confidence: match.match_confidence,
    status: match.match_method === 'ambiguous' ? 'needs_review' : 'extracting',
  })

  var glossary = loadGlossary()

  var extraction = extractFields({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
    captureId: job.capture_id,
    transcript: job.transcript,
    claim: claim,
    templateSpec: tagSchema,
    glossary: glossary,
    phraseBank: [],
    liveExtraction: liveExtraction,
    adjusterName: getOptionalConfig('ADJUSTER_NAME', 'Brandon'),
  })

  logEvent('runner.extracted', {
    capture_id: job.capture_id,
    model: extraction.model,
    field_count: Object.keys(extraction.fields || {}).length,
    unplaced_notes: (extraction.unplaced_notes || []).length,
    live_extraction_fields: liveExtraction ? Object.keys(liveExtraction).length : 0,
  })

  upsertJob(job.capture_id, { status: 'generating', model: extraction.model })

  var validated = validateFields(extraction.fields, job.transcript, tagSchema)
  // Backstop for the fixed set of property facts the transcript is unlikely to
  // ever state — see applyCalendarFallback's own comment for why the
  // transcript-corroboration rule is deliberately skipped for just these tags.
  validated = applyCalendarFallback(validated, calendarFields, tagSchema)
  var unplacedNotes = extraction.unplaced_notes || []
  logEvent('runner.validated', {
    capture_id: job.capture_id,
    valid: Object.keys(validated).filter(function (t) {
      return validated[t].valid
    }).length,
    needs_input: Object.keys(validated).filter(function (t) {
      return !validated[t].valid
    }).length,
  })

  var latestJob = getJobByCaptureId(job.capture_id)
  var result = generateDoc(latestJob, claim, validated, tagSchema, unplacedNotes)

  if (result.status === 'failed') {
    logEvent('runner.docgen_failed', { capture_id: job.capture_id, error: result.error })
    failJob(latestJob, result.error)
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
    error: '',
  })
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
