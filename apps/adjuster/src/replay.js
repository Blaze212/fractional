// Replaying one call's saved artifacts, so a report-rendering change can be
// checked against a real Google Doc without paying for the pipeline that
// produced it.
//
// A run through scripts/adjuster-inject-test-job.mjs spends two batch ASR calls,
// a long-context master-transcript merge and an extraction call before a single
// character reaches the draft. Iterating on docgen/validate/enums that way costs
// real money per attempt for output no vendor has any say in — the fields are
// already decided by the time rendering starts. extraction.json is the artifact
// that makes those runs unnecessary: the extractor's own output, saved beside
// the transcripts it was read from, so the whole rendering half replays from
// Drive.
//
// Both entry points are run by hand from the Apps Script editor, against a
// capture_id off the Jobs tab.

var EXTRACTION_ARTIFACT_NAME = 'extraction.json'
// A replay draft must not mail Brandon a "draft ready" notice for a document
// nobody asked for, and has to be tellable at a glance from the real draft
// sitting next to it in the same folder.
var REPLAY_DOC_OPTIONS = { notify: false, nameSuffix: ' — REPLAY' }

// Same pointer-plus-versioned-file shape the transcripts use: writeCallArtifact
// never overwrites, so a re-extract versions alongside its predecessor and the
// job row carries the id of the newest one.
//
// Wrapped whole: a fixture is a convenience, and losing one must never fail the
// job that was on its way to producing a real draft.
function writeExtractionArtifact(job, claim, input, extraction) {
  var folder = getExistingCallFolder(job)
  if (!folder) return ''

  try {
    var payload = JSON.stringify(
      {
        capture_id: job.capture_id,
        claim_id: (claim && claim.claim_id) || '',
        model: extraction.model || '',
        transcript_source: (input && input.source) || '',
        extracted_at: new Date().toISOString(),
        fields: extraction.fields || {},
        unplaced_notes: extraction.unplaced_notes || [],
      },
      null,
      2,
    )

    var fileId = writeCallArtifact(folder, EXTRACTION_ARTIFACT_NAME, payload)
    upsertJob(job.capture_id, { extraction_artifact_id: fileId })
    logEvent('replay.artifact_written', { capture_id: job.capture_id, file_id: fileId })
    return fileId
  } catch (err) {
    logEvent('replay.artifact_write_failed', {
      capture_id: job.capture_id,
      error: String(err),
    })
    return ''
  }
}

// The job row's pointer first, then a by-name lookup in the call folder — a job
// extracted before this artifact existed has no pointer, but a hand-placed
// extraction.json in its folder still replays.
function readExtractionArtifact(job) {
  var raw = readCallArtifact(job.extraction_artifact_id)

  if (!raw) {
    var folder = getExistingCallFolder(job)
    var files = folder ? folder.getFilesByName(EXTRACTION_ARTIFACT_NAME) : null
    if (files && files.hasNext()) raw = files.next().getBlob().getDataAsString()
  }

  if (!raw) return null

  try {
    return JSON.parse(raw)
  } catch (err) {
    logEvent('replay.artifact_unparseable', { capture_id: job.capture_id, error: String(err) })
    return null
  }
}

// Zero vendor calls. Reads the saved extraction and the saved transcript, then
// runs the same validate-and-render path a live job runs (see
// renderDraftFromExtraction in runner.js). This is the check for every rendering
// change — highlighting, blank sections, spacing, clause shape are only really
// visible in a Google Doc, and this produces one for free.
//
// Deliberately leaves the Jobs row alone. A replay draft is a scratch copy; the
// row keeps pointing at the draft the live run produced.
function regenerateDraftFromArtifacts(captureId) {
  var job = getJobByCaptureId(captureId)
  if (!job) throw new Error('No job for capture_id: ' + captureId)

  var saved = readExtractionArtifact(job)
  if (!saved) {
    throw new Error(
      'No ' +
        EXTRACTION_ARTIFACT_NAME +
        ' for capture_id: ' +
        captureId +
        ' — only calls extracted since this artifact shipped have one. ' +
        'reExtractFromArtifacts() will make one, at the cost of a single extraction call.',
    )
  }

  var claim = findClaimForJob(job)
  var input = resolveExtractionTranscript(job)

  logEvent('replay.regenerating', {
    capture_id: captureId,
    transcript_source: input.source,
    field_count: Object.keys(saved.fields || {}).length,
  })

  var result = renderDraftFromExtraction({
    job: job,
    claim: claim,
    tagSchema: loadEnums(),
    haystack: input.haystack,
    calendarFields: parseCalendarFields(claim),
    fields: saved.fields || {},
    unplacedNotes: saved.unplaced_notes || [],
    docOptions: REPLAY_DOC_OPTIONS,
  })

  logEvent('replay.regenerated', {
    capture_id: captureId,
    status: result.status,
    doc_url: result.docUrl || '',
    error: result.error || '',
  })

  return result
}

// One OpenRouter call — no ASR, no master-transcript merge, no new phone call.
// Re-runs extraction against the transcript already saved for this call, then
// renders. This is the check for a prompt or schema change, where the model's
// own behaviour is the thing under test; every other change verifies through
// regenerateDraftFromArtifacts for free.
function reExtractFromArtifacts(captureId) {
  var job = getJobByCaptureId(captureId)
  if (!job) throw new Error('No job for capture_id: ' + captureId)

  var input = resolveExtractionTranscript(job)
  if (!input.transcript) {
    throw new Error('No saved transcript to re-extract for capture_id: ' + captureId)
  }

  var claim = findClaimForJob(job)
  var tagSchema = loadEnums()
  var hints = buildExtractionHints(job, claim)

  logEvent('replay.re_extracting', {
    capture_id: captureId,
    transcript_source: input.source,
    transcript_chars: input.transcript.length,
  })

  var extraction = runFieldExtraction(job, claim, tagSchema, input, hints)

  var result = renderDraftFromExtraction({
    job: job,
    claim: claim,
    tagSchema: tagSchema,
    haystack: input.haystack,
    calendarFields: hints.calendarFields,
    fields: extraction.fields,
    unplacedNotes: extraction.unplaced_notes || [],
    docOptions: REPLAY_DOC_OPTIONS,
  })

  logEvent('replay.re_extracted', {
    capture_id: captureId,
    model: extraction.model,
    status: result.status,
    doc_url: result.docUrl || '',
    error: result.error || '',
  })

  return result
}
