// options is the replay hatch (see replay.js): a hand-run replay renders a real
// draft to look at, but it is a scratch copy — it must not mail Brandon a
// "draft ready" notice, and it has to be tellable from the real draft in the
// same folder. Absent options, every default is the live pipeline's behaviour.
function generateDoc(job, claim, validated, tagSchema, unplacedNotes, options) {
  var settings = options || {}
  var needsInputCount = countNeedsInput(validated, tagSchema)
  var templateFile = DriveApp.getFileById(getConfig('TEMPLATE_DOC_ID'))
  var draftsFolder = DriveApp.getFolderById(getConfig('DRAFTS_FOLDER_ID'))
  var copy = templateFile.makeCopy(
    buildDraftName(job, claim) + (settings.nameSuffix || ''),
    draftsFolder,
  )
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

  tidyRendering(body)
  styleRoomLabels(body, collectRoomLabels(resolved))
  highlightMarkers(body)
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

  if (settings.notify !== false) notifyDraftReady(copy.getUrl(), needsInputCount)
  return { status: 'done', docUrl: copy.getUrl(), needsInputCount: needsInputCount }
}

// Confidence tiers coming out of validateFields/validateDograhFields/
// applyCalendarFallback: "high" and "dograh" and "calendar" all render
// plainly (the latter two have no transcript source_span to check, but come
// from a source already trusted at that tier — see each function's own
// comment), "low" (and anything else invalid) renders as a [NEEDS INPUT]
// placeholder, "medium" renders the real value unhighlighted with its heard
// citation flagged yellow for a quick human check (see markForReview,
// highlightMarkers). A low-confidence field that
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
      var heard =
        field && field.source_span ? ' — heard: "' + sanitizeSpan(field.source_span) + '"' : ''
      resolved[tag] = { isVariant: isVariant, text: '[NEEDS INPUT: ' + schema.label + heard + ']' }
      return
    }

    if (field.empty) {
      resolved[tag] = { isVariant: isVariant, text: '' }
      return
    }

    var needsReview = field.confidence === 'medium'
    var entry

    if (isVariant) {
      var option = (schema.values || []).filter(function (o) {
        return o.key === field.value
      })[0]
      entry = {
        isVariant: true,
        text: option ? option.text : '[NEEDS INPUT: ' + schema.label + ']',
        needsReview: needsReview && !!option,
        label: schema.label,
      }
    } else {
      entry = {
        isVariant: false,
        text: String(field.value),
        needsReview: needsReview,
        sourceSpan: field.source_span,
        label: schema.label,
      }
    }

    // A field that validated cleanly (not omitted, per the field.empty check
    // above) is a required field by construction — see validate.js's
    // isRequired — so it is always meant to carry visible content. A variant
    // branch with empty canned text (mitigation_status: "none" before Phase 6)
    // is the known way that content can still come out blank; this is the
    // runtime backstop for that case and any other still-missed by the
    // schema-lint test in template.test.ts. Optional fields never reach here
    // with nothing to show — a genuinely blank optional value took the
    // field.empty branch above instead.
    if (schema.required !== false && !String(entry.text).trim()) {
      entry.text = '[NEEDS INPUT: ' + schema.label + ']'
      entry.needsReview = false
    }

    resolved[tag] = entry
  })

  return resolved
}

// Medium confidence gets a visible, plain-text marker rather than a sentinel
// character wrapped around the citation — Google Docs sanitizes ASCII control
// characters out of body text on insert, so a sentinel-based marker never
// survives replaceText and the highlight silently finds nothing. A bracketed
// marker is found and highlighted the same way [NEEDS INPUT: ...] already is
// (see highlightMarkers), and it stays in the document as a note to Brandon,
// identical in kind to [NEEDS INPUT] — he deletes it as he reviews. When there
// is no source_span to cite (a medium-confidence variant, whose canned text
// has no span of its own), fall back to a review marker naming the field
// instead of wrapping the whole expanded value — wrapping the whole variant
// text would paint an entire expanded section, including nested tags filled
// in by pass 2 (e.g. the full room-by-room interior narrative), yellow.
function markForReview(text, sourceSpan, label) {
  if (sourceSpan) return text + ' [heard: "' + sanitizeSpan(sourceSpan) + '"]'
  return text + ' [review: ' + label + ' — medium confidence, no transcript citation]'
}

// Strips [ and ] from a transcript-derived span before it rides into a
// bracketed marker — an unbalanced bracket in a transcribed span breaks the
// [^\]]* match highlightMarkers relies on and silently kills the highlight
// for that field — then collapses whitespace and caps the length so a long
// span doesn't dominate the sentence it's attached to.
function sanitizeSpan(span) {
  var cleaned = String(span).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned
}

function replaceTag(body, tag, resolvedTag) {
  var pattern = '\\{\\{' + tag + '\\}\\}'
  var value = resolvedTag.needsReview
    ? markForReview(resolvedTag.text, resolvedTag.sourceSpan, resolvedTag.label)
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

// The interior and other-structures sections are written as one block per room
// (see prompt.js's interior_damage_narrative guidance): the room name alone on
// its own line ending in a colon, then that room's findings beneath it. Both
// arrive as a single multi-line string in one paragraph, so the room names have
// to be found and styled after insertion — the same after-the-fact pass
// highlightMarkers already does, rather than anything the {{tag}} replacement
// itself could carry.
var ROOM_GROUPED_TAGS = ['interior_damage_narrative', 'other_structures_narrative']

function collectRoomLabels(resolved) {
  var labels = []

  ROOM_GROUPED_TAGS.forEach(function (tag) {
    var entry = resolved[tag]
    if (!entry) return
    roomLabelsIn(entry.text).forEach(function (label) {
      if (labels.indexOf(label) === -1) labels.push(label)
    })
  })

  return labels
}

// A room-name line is a short line that is nothing but a name and a colon. The
// sentence-punctuation and length guards keep a findings line that happens to
// contain a colon ("We observed the following: ...") from being mistaken for one.
function roomLabelsIn(text) {
  return String(text || '')
    .split('\n')
    .map(function (line) {
      return line.trim()
    })
    .filter(function (line) {
      return line.length > 1 && line.length <= 60 && /^[^:.!?]+:$/.test(line)
    })
}

// Bold + italic, matching the shape Brandon's finished reports use for a room
// heading. Each label is matched as a literal, and only where it starts a line —
// without that check "Garage:" would also match the tail of "Detached Garage:"
// and style half of it.
function styleRoomLabels(body, labels) {
  labels.forEach(function (label) {
    var pattern = escapeForFindText(label)
    var found = body.findText(pattern)

    while (found) {
      var text = found.getElement().asText()
      var start = found.getStartOffset()
      var end = found.getEndOffsetInclusive()

      if (start === 0 || text.getText().charAt(start - 1) === '\n') {
        text.setBold(start, end, true)
        text.setItalic(start, end, true)
      }

      found = body.findText(pattern, found)
    }
  })
}

function escapeForFindText(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Cleans up the residue an omitted optional field leaves behind mid-sentence —
// the only always-visible optional field today is coverage_supporting_detail,
// which sits inside all three coverage branches and leaves a double space when
// left out. Runs after both replacement passes (it operates on final rendered
// text) and before styleRoomLabels/highlightMarkers, since collapsing spaces
// shifts character offsets those later passes locate text by.
function tidyRendering(body) {
  body.replaceText('[ ]{2,}', ' ')
  body.replaceText(' \\.', '.')
  body.replaceText(' \\,', ',')
  body.replaceText(',[ ]*,', ',')
  body.replaceText('[ ]+\\n', '\n')
}

// One pass over every plain-text marker kind: a needs-input placeholder, a
// heard citation trailing a medium-confidence value, and a no-citation review
// flag on a medium-confidence variant. All three are notes to Brandon and stay
// in the document text — he deletes them as he reviews — so this only paints
// the highlight, unlike the old sentinel-wrapped markers it replaces, which
// had to be stripped back out after being found.
function highlightMarkers(body) {
  var pattern = '\\[(NEEDS INPUT|heard|review):[^\\]]*\\]'
  var found = body.findText(pattern)

  while (found) {
    var range = found.getElement()
    var start = found.getStartOffset()
    var end = found.getEndOffsetInclusive()
    range.asText().setBackgroundColor(start, end, '#FFFF00')
    found = body.findText(pattern, found)
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

// Two kinds of needs-input land in a draft: a field that failed validation, and
// a field that validated cleanly onto a variant branch whose own canned text
// carries a [NEEDS INPUT] marker (coverage_determination "unknown",
// personal_property_status "damaged"). Both are highlighted yellow in the body,
// so both belong in the header's count — counting only the first left the header
// reading "Needs input: 0" on a draft with an unresolved coverage question in it.
function countNeedsInput(validated, tagSchema) {
  return Object.keys(validated).filter(function (tag) {
    var field = validated[tag]
    if (!field.valid) return true
    return variantTextNeedsInput((tagSchema || {})[tag], field)
  }).length
}

function variantTextNeedsInput(schema, field) {
  if (!schema || schema.type !== 'variant' || field.empty) return false

  var option = (schema.values || []).filter(function (o) {
    return o.key === field.value
  })[0]

  return !!option && option.text.indexOf('[NEEDS INPUT:') !== -1
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
