function generateDoc(job, claim, validated, tagSchema, unplacedNotes) {
  var needsInputCount = countNeedsInput(validated)
  var templateFile = DriveApp.getFileById(getConfig('TEMPLATE_DOC_ID'))
  var draftsFolder = DriveApp.getFolderById(getConfig('DRAFTS_FOLDER_ID'))
  var copy = templateFile.makeCopy(buildDraftName(job, claim), draftsFolder)
  var doc = DocumentApp.openById(copy.getId())
  var body = doc.getBody()

  insertHeaderBlock(body, job, claim, needsInputCount)

  var resolved = resolveTagsForDoc(validated, tagSchema)

  // Pass 1: variant tags expand to stored paragraph text, which may itself contain
  // other {{tags}} (e.g. coverage_determination's text references {{loss_cause}}).
  Object.keys(resolved).forEach(function (tag) {
    if (resolved[tag].isVariant) replaceTag(body, tag, resolved[tag])
  })

  // Pass 2: every remaining leaf tag, including ones newly exposed by pass 1.
  Object.keys(resolved).forEach(function (tag) {
    if (!resolved[tag].isVariant) replaceTag(body, tag, resolved[tag])
  })

  highlightNeedsInput(body)
  highlightMediumConfidence(body)
  appendUnplacedNotes(body, unplacedNotes)
  doc.saveAndClose()

  var leftoverTags = findLeftoverTags(DocumentApp.openById(copy.getId()).getBody().getText())
  if (leftoverTags.length > 0) {
    return {
      status: 'failed',
      error: 'Unreplaced tags: ' + leftoverTags.join(', '),
      docUrl: copy.getUrl(),
      needsInputCount: needsInputCount,
    }
  }

  notifyDraftReady(copy.getUrl(), needsInputCount)
  return { status: 'done', docUrl: copy.getUrl(), needsInputCount: needsInputCount }
}

// Confidence tiers coming out of validateFields/validateDograhFields/
// applyCalendarFallback: "high" and "dograh" and "calendar" all render
// plainly (the latter two have no transcript source_span to check, but come
// from a source already trusted at that tier — see each function's own
// comment), "low" (and anything else invalid) renders as a [NEEDS INPUT]
// placeholder, "medium" renders the real value unhighlighted with its heard
// citation flagged yellow for a quick human check (see markForReview,
// highlightMediumConfidence). A low-confidence field that
// still carries a source_span (see validate.js's needsInput) had real,
// verified transcript text behind it — just enough that the model wasn't sure
// how to render it — so that snippet rides along on the placeholder as a
// "heard" hint instead of leaving the adjuster to start from zero.
function resolveTagsForDoc(validated, tagSchema) {
  var resolved = {}

  Object.keys(tagSchema).forEach(function (tag) {
    var schema = tagSchema[tag]
    var field = validated[tag]
    var isVariant = schema.type === 'variant'

    if (!field || !field.valid) {
      var heard = field && field.source_span ? ' — heard: "' + field.source_span + '"' : ''
      resolved[tag] = { isVariant: isVariant, text: '[NEEDS INPUT: ' + schema.label + heard + ']' }
      return
    }

    if (field.empty) {
      resolved[tag] = { isVariant: isVariant, text: '' }
      return
    }

    var needsReview = field.confidence === 'medium'

    if (isVariant) {
      var option = (schema.values || []).filter(function (o) {
        return o.key === field.value
      })[0]
      resolved[tag] = {
        isVariant: true,
        text: option ? option.text : '[NEEDS INPUT: ' + schema.label + ']',
        needsReview: needsReview && !!option,
      }
      return
    }

    resolved[tag] = {
      isVariant: false,
      text: String(field.value),
      needsReview: needsReview,
      sourceSpan: field.source_span,
    }
  })

  return resolved
}

// Sentinel characters wrapped around the heard citation on medium-confidence
// text so it (and only it) can be found and highlighted after insertion, then
// stripped — mirrors how [NEEDS INPUT: ...] is a plain-text marker
// highlightNeedsInput finds and styles, except here the wrapped text is the
// heard citation and the markers themselves must not survive into the final
// doc. The real sentence stays unhighlighted — it is the value we actually
// want kept in the report — only the trailing heard citation is flagged
// yellow, so it reads as a note to check rather than something that belongs
// in the final text. When there is no heard citation to isolate (e.g. a
// variant option's canned text), fall back to flagging the whole value so
// medium confidence still gets a visible flag.
var REVIEW_MARK_START = ''
var REVIEW_MARK_END = ''

function markForReview(text, sourceSpan) {
  var heard = sourceSpan ? ' [heard: "' + sourceSpan + '"]' : ''
  if (!heard) return REVIEW_MARK_START + text + REVIEW_MARK_END
  return text + REVIEW_MARK_START + heard + REVIEW_MARK_END
}

function replaceTag(body, tag, resolvedTag) {
  var pattern = '\\{\\{' + tag + '\\}\\}'
  var value = resolvedTag.needsReview
    ? markForReview(resolvedTag.text, resolvedTag.sourceSpan)
    : resolvedTag.text
  var safeValue = String(value).replace(/\$/g, '$$$$')
  body.replaceText(pattern, safeValue)
}

function insertHeaderBlock(body, job, claim, needsInputCount) {
  var lines = [
    'Capture ID: ' + job.capture_id,
    'Call time: ' + job.call_started_at + ' (' + job.duration_sec + 's)',
  ]

  if (claim) {
    lines.push('Insured: ' + claim.insured_last_name + ' — ' + claim.address_line1)
  }

  lines.push('Match: ' + job.match_method + ' / ' + job.match_confidence)
  if (job.match_method === 'ambiguous')
    lines.push('Contested — check the matched claim before sending.')
  lines.push('Model: ' + job.model)
  lines.push('Needs input: ' + needsInputCount)
  if (job.audio_drive_id) lines.push('Audio: https://drive.google.com/file/d/' + job.audio_drive_id)
  // The draft keeps landing in DRAFTS_FOLDER_ID where Brandon already looks for
  // it; this is the way back to everything else the call produced.
  if (job.call_folder_id) {
    lines.push('Call folder: https://drive.google.com/drive/folders/' + job.call_folder_id)
  }

  var paragraph = body.insertParagraph(0, lines.join('\n'))
  paragraph.editAsText().setBold(true)
  body.insertHorizontalRule(1)
}

function buildDraftName(job, claim) {
  var date = new Date().toISOString().slice(0, 10)
  var who = claim ? claim.insured_last_name : 'UNMATCHED'
  var address = claim ? claim.address_line1 : job.capture_id
  return date + ' — ' + who + ' — ' + address
}

function highlightNeedsInput(body) {
  var found = body.findText('\\[NEEDS INPUT:[^\\]]*\\]')

  while (found) {
    var range = found.getElement()
    var start = found.getStartOffset()
    var end = found.getEndOffsetInclusive()
    range.asText().setBackgroundColor(start, end, '#FFFF00')
    found = body.findText('\\[NEEDS INPUT:[^\\]]*\\]', found)
  }
}

// Medium-confidence values are inserted already wrapped in REVIEW_MARK_START/
// END (see markForReview). Unlike [NEEDS INPUT: ...], the marker characters
// are not meant to survive into the final doc — only the highlight is.
function highlightMediumConfidence(body) {
  var pattern = REVIEW_MARK_START + '[^' + REVIEW_MARK_END + ']*' + REVIEW_MARK_END
  var found = body.findText(pattern)

  while (found) {
    var range = found.getElement()
    var text = range.asText()
    var start = found.getStartOffset()
    var end = found.getEndOffsetInclusive()
    text.setBackgroundColor(start, end, '#FFFF00')
    // Delete the trailing marker before the leading one so the earlier
    // index isn't shifted out from under the second deleteText call.
    text.deleteText(end, end)
    text.deleteText(start, start)
    found = body.findText(pattern)
  }
}

function appendUnplacedNotes(body, unplacedNotes) {
  if (!unplacedNotes || unplacedNotes.length === 0) return

  body.appendParagraph('Not placed').editAsText().setBold(true)
  unplacedNotes.forEach(function (note) {
    body.appendParagraph('- ' + note)
  })
}

function findLeftoverTags(text) {
  var matches = text.match(/\{\{\w+\}\}/g)
  return matches || []
}

function countNeedsInput(validated) {
  return Object.keys(validated).filter(function (tag) {
    return !validated[tag].valid
  }).length
}

function notifyDraftReady(docUrl, needsInputCount) {
  var recipients = getConfigList('NOTIFY_EMAILS', [])
  if (recipients.length === 0) return

  MailApp.sendEmail({
    to: recipients.join(','),
    subject: 'Adjuster draft ready (' + needsInputCount + ' needs input)',
    body: 'Draft: ' + docUrl,
  })
}

function notifyJobFailed(job, error) {
  var recipients = getConfigList('NOTIFY_EMAILS', [])
  if (recipients.length === 0) return

  MailApp.sendEmail({
    to: recipients.join(','),
    subject: 'Adjuster job failed: ' + job.capture_id,
    body: error,
  })
}
