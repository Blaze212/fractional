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
// Doc pane template — the report's own prose, transcribed verbatim from
// template/template.flattened.txt, kept ONLY so the review page can preview
// each field in the sentence it actually renders into. docgen.js's real
// Google Doc template (the .docx) stays the single source of truth for the
// generated report; this is a read-only echo of it for review context, not a
// second implementation of doc assembly. [BRACKET] tokens (e.g. [DATE_LOSS])
// are claim-level merge fields docgen.js resolves outside tagSchema — shown
// here as plain static text, not a review chip, since there's no field to
// accept/reject.
// ---------------------------------------------------------------------------

var SECTION_TEMPLATES = {
  Assignment:
    'This loss was received by Ibis Claim Services on [DATE_RECEIVED]. Contact was made with {{contacted_party_name}} on [DATE_CONTACTED] and the inspection was scheduled for [DATE_INSPECTED]. The loss was inspected at the scheduled date and time. {{present_at_inspection}}',
  Mortgage: '{{mortgage_status}}',
  Origin:
    'Damage occurred due to {{origin_narrative}} on [DATE_LOSS], resulting in damage to {{origin_damage_narrative}}.',
  Coverage:
    "The damages to the insured's property are {{coverage_cause_narrative}}, {{coverage_determination}}",
  Risk: 'The dwelling is a {{dwelling_stories}}, {{dwelling_type}} structure. It was built in {{year_built}} on a {{foundation_type}} foundation. The dwelling is wood framed with {{siding_type}}, and composition shingle roofing. The interior of the dwelling measures approximately {{square_footage}} square feet with {{bedroom_count}} bedrooms and {{bathroom_count}} bathrooms. The home is currently occupied by {{occupancy_status}}.',
  Roof: '{{roof_status}}\n\nSoft Metals: {{soft_metal_status}}\nFront Slope: {{front_slope_status}}\nRight Slope: {{right_slope_status}}\nBack Slope: {{back_slope_status}}\nLeft Slope: {{left_slope_status}}',
  Exterior:
    '{{exterior_status}}\n\nFront Elevation: {{front_elevation_status}}\nRight Elevation: {{right_elevation_status}}\nBack Elevation: {{back_elevation_status}}\nLeft Elevation: {{left_elevation_status}}',
  Interior: '{{interior_status}}',
  'Other Structures': '{{other_structures_status}}',
  'Personal Property': '{{personal_property_status}}',
  Mitigation: '{{mitigation_status}}',
  'Overhead & Profit': '{{overhead_profit_narrative}}',
  'Salvage & Subrogation':
    'There are no subrogation possibilities as the damages are {{subrogation_reason}}. Any possible salvage value is negated by cost of removal, delivery, and sale.',
  Coinsurance: '{{coinsurance_status}}',
}

// Splits template prose into literal text, {{tag}} review-chip markers, and
// [BRACKET] static-merge-field markers. A bracket token must be all
// caps/underscores with nothing else inside it — "[NEEDS INPUT: Confirm ...]"
// (space, colon, lowercase) fails that shape on purpose and falls through as
// literal text instead of a fake placeholder chip.
function tokenizeTemplateText(text) {
  var tokens = []
  var pattern = /\{\{(\w+)\}\}|\[([A-Z][A-Z0-9_]*)\]/g
  var lastIndex = 0
  var match

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    if (match[1]) {
      tokens.push({ type: 'tag', tag: match[1] })
    } else {
      tokens.push({ type: 'placeholder', name: match[2] })
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return tokens
}

// A resolved (valid, non-empty) field that was never review-eligible (see
// buildReviewItems in runner.js — not in reviewTagSet) just prints its value;
// there is no card for it to link to.
function resolvedDisplayValue(field) {
  if (!field || !field.valid || field.empty) return ''
  return String(field.value)
}

// Expands one tag into a flat list of text/tag/placeholder blocks.
//
// A resolved (valid, non-empty) variant's canned option text (enums.json's
// values[].text) is always spliced in and walked the same way, regardless of
// its own review-eligibility, so a nested tag reference (e.g. roof_status's
// "shingle" option pulling in
// roof_covering_type/roof_age_years/roof_condition/roof_pitch) shows up as
// its own chip in context instead of collapsing into one opaque block — a
// medium-confidence roof_status still gets its own card in the rail (see
// reviewTagSet), just not a distinct highlighted span here.
//
// Everything else is a leaf: reviewTagSet membership decides whether it
// renders as a clickable review chip or as plain resolved text. depth is a
// defensive cycle guard; enums.json has no cycles today.
function expandTagBlocks(tag, validated, tagSchema, reviewTagSet, depth) {
  depth = depth || 0
  var schema = tagSchema[tag]
  if (!schema) return [{ type: 'text', value: '{{' + tag + '}}' }]

  var field = validated[tag]
  var resolved = schema.type === 'variant' && depth <= 6 && field && field.valid && !field.empty

  if (resolved) {
    var option = (schema.values || []).filter(function (o) {
      return o.key === field.value
    })[0]
    if (option) {
      var blocks = []
      tokenizeTemplateText(option.text).forEach(function (token) {
        if (token.type === 'tag') {
          blocks = blocks.concat(
            expandTagBlocks(token.tag, validated, tagSchema, reviewTagSet, depth + 1),
          )
        } else {
          blocks.push(token)
        }
      })
      return blocks
    }
  }

  if (reviewTagSet[tag]) return [{ type: 'tag', tag: tag }]
  return [{ type: 'text', value: resolvedDisplayValue(field) }]
}

// One flat blocks array per section in SECTION_TEMPLATES, ready for the page
// to render as chips-in-prose (see reviewUi.html's renderDocPane).
function buildDocBlocks(validated, tagSchema, reviewTagSet) {
  var bySection = {}
  Object.keys(SECTION_TEMPLATES).forEach(function (section) {
    var blocks = []
    tokenizeTemplateText(SECTION_TEMPLATES[section]).forEach(function (token) {
      if (token.type === 'tag') {
        blocks = blocks.concat(expandTagBlocks(token.tag, validated, tagSchema, reviewTagSet, 0))
      } else {
        blocks.push(token)
      }
    })
    bySection[section] = blocks
  })
  return bySection
}

// Best-effort transcript for display only — NOT the exact haystack
// validateFields checked spans against (that's buildSpanHaystack's
// speaker-label-stripped text, sometimes read back out of Drive via
// transcript_master_id — see resolveExtractionTranscript in
// transcription.js). Prefers the master transcript when one exists, same
// preference order, just without re-deriving the haystack transform, since
// this only has to be readable to a human, not re-validated.
function reviewTranscriptText(job) {
  var master = readCallArtifact(job.transcript_master_id) || String(job.transcript_master || '')
  return master || String(job.transcript || '')
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

  var tagSchema = loadEnums()
  var validated = job.validated_json ? JSON.parse(job.validated_json) : {}
  var notes = job.unplaced_notes_json ? JSON.parse(job.unplaced_notes_json) : []

  var reviewTagSet = {}
  items.forEach(function (item) {
    reviewTagSet[item.tag] = true
  })

  return {
    job_id: job.capture_id,
    claim_id: job.claim_id || '',
    status: job.status,
    items: items,
    doc_blocks: buildDocBlocks(validated, tagSchema, reviewTagSet),
    notes: notes,
    transcript: reviewTranscriptText(job),
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
