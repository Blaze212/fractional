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
    if (resolved[tag].isVariant) replaceTag(body, tag, resolved[tag].text)
  })

  // Pass 2: every remaining leaf tag, including ones newly exposed by pass 1.
  Object.keys(resolved).forEach(function (tag) {
    if (!resolved[tag].isVariant) replaceTag(body, tag, resolved[tag].text)
  })

  highlightNeedsInput(body)
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

function resolveTagsForDoc(validated, tagSchema) {
  var resolved = {}

  Object.keys(tagSchema).forEach(function (tag) {
    var schema = tagSchema[tag]
    var field = validated[tag]
    var isVariant = schema.type === 'variant'

    if (!field || !field.valid) {
      resolved[tag] = { isVariant: isVariant, text: '[NEEDS INPUT: ' + schema.label + ']' }
      return
    }

    if (field.empty) {
      resolved[tag] = { isVariant: isVariant, text: '' }
      return
    }

    if (isVariant) {
      var option = (schema.values || []).filter(function (o) {
        return o.key === field.value
      })[0]
      resolved[tag] = {
        isVariant: true,
        text: option ? option.text : '[NEEDS INPUT: ' + schema.label + ']',
      }
      return
    }

    resolved[tag] = { isVariant: false, text: String(field.value) }
  })

  return resolved
}

function replaceTag(body, tag, value) {
  var pattern = '\\{\\{' + tag + '\\}\\}'
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
