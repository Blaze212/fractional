function runPipelineTick() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(5000)) return

  try {
    reclaimStuckJobs()
    promoteStaleAwaitingTranscript()
    processOldestPendingJob()
  } finally {
    lock.releaseLock()
  }
}

function processOldestPendingJob() {
  var picked = getOldestPendingJob()
  if (!picked.job) return

  var job = picked.job
  leaseJob(picked.sheet, picked.headers, job)

  try {
    runJobPipeline(job)
  } catch (e) {
    failJob(job, e.message)
  }
}

function leaseJob(sheet, headers, job) {
  writeRowFields(sheet, headers, job._rowIndex, {
    status: 'matching',
    lease_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: Number(job.attempts || 0) + 1,
  })
}

function runJobPipeline(job) {
  var claims = getClaims()
  var match = matchClaim(job.call_started_at, job.transcript, claims)
  var claim = match.claim_id
    ? claims.filter(function (c) {
        return c.claim_id === match.claim_id
      })[0]
    : null

  upsertJob(job.capture_id, {
    claim_id: match.claim_id || '',
    match_method: match.match_method,
    match_confidence: match.match_confidence,
    status: match.match_method === 'ambiguous' ? 'needs_review' : 'extracting',
  })

  var tagSchema = loadEnums()
  var glossary = loadGlossary()

  var extraction = extractFields({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
    transcript: job.transcript,
    claim: claim,
    templateSpec: tagSchema,
    glossary: glossary,
    phraseBank: [],
  })

  upsertJob(job.capture_id, { status: 'generating', model: extraction.model })

  var validated = validateFields(extraction.fields, job.transcript, tagSchema)
  var latestJob = getJobByCaptureId(job.capture_id)
  var result = generateDoc(latestJob, claim, validated, tagSchema, extraction.unplaced_notes)

  if (result.status === 'failed') {
    failJob(latestJob, result.error)
    return
  }

  upsertJob(job.capture_id, {
    status: 'done',
    doc_url: result.docUrl,
    needs_input_count: result.needsInputCount,
  })
}

function failJob(job, errorMessage) {
  var attempts = Number(job.attempts || 0)
  var status = attempts >= 3 ? 'failed' : 'pending'

  upsertJob(job.capture_id, { status: status, error: errorMessage })

  if (status === 'failed') notifyJobFailed(job, errorMessage)
}
