// Review UI prototype (option A — native Apps Script HtmlService, see
// docs/specs/012-adjuster-review-webapp.md's "Runtime bridge" section for the
// Vite/Supabase design this instead avoids). Serves a browser page directly
// from this Apps Script project and reads/writes review state against the
// Review tab (see jobs.js) instead of bridging to a separate app + database.
//
// doGet(e) in webhook.js routes ?page=review here.
function renderReviewPage() {
  // clasp preserves the src/ prefix as part of the pushed file's name (see
  // .clasp.json's rootDir: "" — everything pushes relative to apps/adjuster/),
  // so the Apps Script project sees this file as "src/reviewUi", not
  // "reviewUi". Confirm the exact name in the Apps Script editor's file list
  // after the first `clasp push` if this throws "reviewUi not found."
  var template = HtmlService.createTemplateFromFile('src/reviewUi')
  return template
    .evaluate()
    .setTitle('Adjuster Review')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
}

// ---------------------------------------------------------------------------
// Server functions called from reviewUi.html via google.script.run.
// ---------------------------------------------------------------------------

function reviewListJobs() {
  return listJobsNeedingReview().map(function (job) {
    var items = getReviewItemsForJob(job.capture_id)
    return {
      job_id: job.capture_id,
      claim_id: job.claim_id || '',
      created_at: job.created_at || '',
      item_count: items.length,
      pending_count: items.filter(function (item) {
        return item.status === 'pending'
      }).length,
    }
  })
}

function reviewGetJob(jobId) {
  var job = getJobByCaptureId(jobId)
  if (!job) throw new Error('No job for capture_id=' + jobId)

  var items = getReviewItemsForJob(jobId).map(function (item) {
    return {
      tag: item.tag,
      label: item.label,
      section: item.section,
      source_span: item.source_span,
      confidence: item.confidence,
      status: item.status,
      resolved_value: item.resolved_value,
    }
  })

  return {
    job_id: job.capture_id,
    claim_id: job.claim_id || '',
    status: job.status,
    items: items,
  }
}

function reviewDecide(jobId, tag, status, resolvedValue) {
  if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') {
    throw new Error('Invalid review status: ' + status)
  }
  updateReviewItemDecision(jobId, tag, status, resolvedValue || '')
  return reviewGetJob(jobId)
}

// Merges every 'accepted' decision into the job's saved validated map (see
// runExtractionStage's validated_json write in runner.js), then runs the same
// generateDoc() the automatic no-review-needed path uses (finalizeDraftGeneration
// in runner.js). A rejected or still-pending item is left exactly as validation
// produced it, so it renders as [NEEDS INPUT] same as today — reject-and-finalize
// is allowed by design (spec 012's Edge Cases table).
function reviewFinalize(jobId) {
  var job = getJobByCaptureId(jobId)
  if (!job) throw new Error('No job for capture_id=' + jobId)
  if (!job.validated_json) throw new Error('Job has no saved validated field map: ' + jobId)

  var validated = JSON.parse(job.validated_json)
  var tagSchema = loadEnums()
  var claim = findClaimForJob(job)
  var items = getReviewItemsForJob(jobId)

  items.forEach(function (item) {
    if (item.status !== 'accepted') return

    var schema = tagSchema[item.tag]
    var value = item.resolved_value || item.source_span || ''
    validated[item.tag] = {
      valid: true,
      label: (schema && schema.label) || item.label,
      value: value,
      source_span: item.source_span || '',
      confidence: 'reviewed',
    }
  })

  var result = finalizeDraftGeneration(job, claim, validated, tagSchema, [])

  logEvent('reviewUi.finalized', {
    capture_id: jobId,
    accepted_count: items.filter(function (item) {
      return item.status === 'accepted'
    }).length,
    rejected_count: items.filter(function (item) {
      return item.status === 'rejected'
    }).length,
    pending_count: items.filter(function (item) {
      return item.status === 'pending'
    }).length,
  })

  return result
}
