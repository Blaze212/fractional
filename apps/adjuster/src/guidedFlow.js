// Guided (section-by-section) call flow — an alternative to the single-shot
// "dump your notes" flow in webhook.js/field-notes.xml. Not wired live: nothing
// outside this file and its webhook.js dispatch branch changes when this file is
// added, and no Telnyx phone number needs to point at it. Swapping between flows
// is a matter of which static bootstrap XML a Telnyx number's Voice URL points
// at — field-notes.xml (single Record) or guided-intake.xml (redirects into
// `guided_start` here). Both hit the same Apps Script deployment and the same
// Jobs sheet; this file writes the exact same `transcript`/`status` shape
// webhook.js's single-shot handlers already write, so matcher.js/prompt.js/
// runner.js need zero changes to consume a guided-flow job.
//
// See apps/adjuster/docs/telnyx-texml-interactive-ivr.md and
// apps/adjuster/template/interactive-call-script.txt for the design this
// implements — verb choice per section, why branch+detail fields are bundled
// into one AIGather turn, and why cross-section reconciliation happens once at
// the end instead of trying to route stray content live.
//
// UNCONFIRMED AGAINST A LIVE CALL: the exact POST parameter name(s) Telnyx uses
// to deliver AIGather's extracted JSON on the `action` callback. Docs describe
// "base64-encoded JSON" in the payload but not the field name it arrives under.
// parseAIGatherResult() below checks several candidate names as a hedge, the
// same defensive pattern webhook.js's firstParam() already uses for confirmed
// fields — replace with the confirmed name after a real test call, the same way
// webhook.js's own top-of-file comment documents doing for CallSessionId.

var GUIDED_SECTIONS = [
  {
    id: 'contact_info',
    verb: 'record',
    say: "Hi, you've called the claim line. Let's walk the Ibis template. Who's the insured, and what's the property address?",
    maxLength: 45,
    next: 'claim_info',
  },
  {
    id: 'claim_info',
    verb: 'record',
    say: 'Claim number and carrier?',
    maxLength: 30,
    next: 'assignment',
  },
  {
    id: 'assignment',
    verb: 'aigather',
    say: "Who'd you make contact with to set this up, and who was at the inspection?",
    schema: {
      type: 'object',
      properties: {
        contacted_party_name: {
          type: 'string',
          description: 'who the adjuster contacted to set up the inspection',
        },
        present_at_inspection: { type: 'string', description: 'who was present at the inspection' },
      },
      required: ['contacted_party_name', 'present_at_inspection'],
    },
    next: 'mortgage',
  },
  {
    id: 'mortgage',
    verb: 'aigather',
    say: 'Does the insured have a mortgage on the property?',
    schema: {
      type: 'object',
      properties: {
        mortgage_status: { type: 'string', enum: ['has_mortgage', 'no_mortgage'] },
        mortgage_company: {
          type: 'string',
          description: 'the mortgage company name, only if there is a mortgage',
        },
      },
      required: ['mortgage_status'],
    },
    next: 'origin',
  },
  {
    id: 'origin',
    verb: 'record',
    say: 'What happened — walk me through the cause of loss.',
    maxLength: 240,
    next: 'coverage',
  },
  {
    id: 'coverage',
    verb: 'aigather',
    say: "What's the coverage situation on this one?",
    schema: {
      type: 'object',
      properties: {
        coverage_cause_narrative: {
          type: 'string',
          description:
            'the coverage cause clause, e.g. "wind related", "burst plumbing line due to freezing"',
        },
        coverage_determination: { type: 'string', enum: ['covered', 'excluded'] },
        coverage_supporting_detail: {
          type: 'string',
          description:
            'optional supporting detail, e.g. confirming heat was maintained for a freeze claim',
        },
      },
      required: ['coverage_cause_narrative', 'coverage_determination'],
    },
    next: 'risk_information',
  },
  {
    id: 'risk_information',
    verb: 'aigather',
    say: "Give me the dwelling — stories, type, foundation, square footage, bedrooms, bathrooms, and who's living there.",
    schema: {
      type: 'object',
      properties: {
        dwelling_stories: {
          type: 'string',
          description: 'e.g. 1 story, 2 story, a story and a half — use what the adjuster says',
        },
        dwelling_type: {
          type: 'string',
          description:
            "e.g. single family, duplex, apartment, townhome — use what the adjuster says, don't force a category",
        },
        foundation_type: { type: 'string', enum: ['crawlspace', 'basement', 'slab'] },
        square_footage: { type: 'string' },
        bedroom_count: { type: 'integer' },
        bathroom_count: { type: 'integer' },
        occupancy_status: { type: 'string', enum: ['the insured', 'a tenant', 'tenants'] },
      },
      required: [
        'dwelling_stories',
        'dwelling_type',
        'foundation_type',
        'square_footage',
        'bedroom_count',
        'bathroom_count',
        'occupancy_status',
      ],
    },
    next: 'risk_siding_year',
  },
  {
    id: 'risk_siding_year',
    verb: 'aigather',
    say: "What's the siding, and roughly what year was it built?",
    schema: {
      type: 'object',
      properties: {
        siding_type: {
          type: 'string',
          description:
            'e.g. vinyl siding, brick veneer, stucco, wood siding, fiber cement siding — use what the adjuster says',
        },
        year_built: {
          type: 'string',
          description: 'optional — omit if the adjuster does not know it',
        },
      },
      required: ['siding_type'],
    },
    next: 'roof_status',
  },
  {
    id: 'roof_status',
    verb: 'gather',
    say: 'Roof — affected or not?',
    field: 'roof_status',
    // roof_status stays a plain Gather rather than folding into an AIGather
    // turn because it decides which schema the *next* turn even uses — it has
    // to resolve before that follow-up question can be built.
    branch: {
      not_affected: 'exterior',
      shingle: 'roof_shingle',
      other_material: 'roof_other',
    },
  },
  {
    id: 'roof_shingle',
    verb: 'aigather',
    say: 'Tell me about the roof — material, age, condition, pitch, and what you found slope by slope, including anything with no damage.',
    schema: {
      type: 'object',
      properties: {
        roof_covering_type: {
          type: 'string',
          description:
            'e.g. 30 year laminate shingles, 20 year 3 tab shingles, wood shingles, cedar shakes',
        },
        roof_age_years: { type: 'string' },
        roof_condition: { type: 'string', enum: ['average', 'below average'] },
        roof_pitch: { type: 'string', description: 'e.g. 6/12' },
        roof_damage_narrative: {
          type: 'string',
          description: 'per-slope findings, including slopes with no damage',
        },
      },
      required: [
        'roof_covering_type',
        'roof_age_years',
        'roof_condition',
        'roof_pitch',
        'roof_damage_narrative',
      ],
    },
    next: 'exterior',
  },
  {
    id: 'roof_other',
    verb: 'record',
    say: "It's not shingle, so just describe the whole thing — material, age, condition, layers, pitch, per-slope findings, and your conclusion.",
    maxLength: 240,
    next: 'exterior',
  },
  {
    id: 'exterior',
    verb: 'aigather',
    say: 'Exterior?',
    schema: {
      type: 'object',
      properties: {
        exterior_status: { type: 'string', enum: ['not_affected', 'affected'] },
        exterior_narrative: {
          type: 'string',
          description: 'elevation-by-elevation findings, only if affected',
        },
      },
      required: ['exterior_status'],
    },
    next: 'interior',
  },
  {
    id: 'interior',
    verb: 'record',
    say: 'Interior?',
    maxLength: 180,
    next: 'personal_property',
  },
  {
    id: 'personal_property',
    verb: 'aigather',
    say: 'Personal property?',
    schema: {
      type: 'object',
      properties: {
        personal_property_status: { type: 'string', enum: ['none', 'damaged'] },
        personal_property_narrative: {
          type: 'string',
          description: 'what was damaged, only if status is damaged',
        },
      },
      required: ['personal_property_status'],
    },
    next: 'mitigation',
  },
  {
    id: 'mitigation',
    verb: 'aigather',
    say: 'Mitigation vendor involved?',
    schema: {
      type: 'object',
      properties: {
        mitigation_status: { type: 'string', enum: ['none', 'present'] },
        mitigation_narrative: {
          type: 'string',
          description: 'who, what, when — only if a vendor was involved',
        },
      },
      required: ['mitigation_status'],
    },
    next: 'overhead_profit',
  },
  {
    id: 'overhead_profit',
    verb: 'record',
    say: 'Overhead and profit?',
    maxLength: 120,
    next: 'subrogation',
  },
  {
    id: 'subrogation',
    verb: 'record',
    say: 'Any subrogation angle, or is this a dead end?',
    maxLength: 120,
    next: 'coinsurance',
  },
  {
    id: 'coinsurance',
    verb: 'record',
    say: 'Coinsurance?',
    maxLength: 90,
    next: null,
  },
]

var GUIDED_SECTIONS_BY_ID = GUIDED_SECTIONS.reduce(function (map, section) {
  map[section.id] = section
  return map
}, {})

var FIRST_GUIDED_SECTION_ID = GUIDED_SECTIONS[0].id

// --- entry points, called from webhook.js's routeWebhook ---

function handleGuidedStart(callSessionId) {
  var state = {
    flow: 'guided',
    currentStep: FIRST_GUIDED_SECTION_ID,
    captured: {},
    sectionTranscripts: [],
  }
  return withJobLock(function () {
    persistGuidedState(callSessionId, state)
    return texmlResponse(buildSectionTeXML(GUIDED_SECTIONS_BY_ID[FIRST_GUIDED_SECTION_ID]))
  })
}

function handleGuidedAction(callSessionId, params) {
  var step = params.step || ''
  var section = GUIDED_SECTIONS_BY_ID[step]

  if (!section) {
    logEvent('guided.unknown_step', { capture_id: callSessionId, step: step })
    return texmlResponse('<Response><Hangup/></Response>')
  }

  return withJobLock(function () {
    var state = loadGuidedState(callSessionId)

    if (section.verb === 'gather') {
      applyGatherResult(callSessionId, state, section, params)
    } else if (section.verb === 'aigather') {
      applyAIGatherResult(callSessionId, state, section, params)
    } else if (section.verb === 'record') {
      // The transcript isn't ready yet — Record's action callback fires the
      // moment the recording stops, transcription arrives later via a
      // separate `guided_transcription` event. Reserve this step's slot now
      // so out-of-order transcription callbacks land in the right place.
      reserveSectionTranscript(
        state,
        section.id,
        firstParam(params, ['RecordingUrl', 'recording_url']),
      )
    }

    var nextId = nextSectionId(section, state)
    state.currentStep = nextId
    persistGuidedState(callSessionId, state)

    if (!nextId) {
      return texmlResponse(
        '<Response><Say voice="Telnyx.Natural.brook">Got it, that\'s everything. Hang up whenever you\'re ready.</Say></Response>',
      )
    }

    return texmlResponse(buildSectionTeXML(GUIDED_SECTIONS_BY_ID[nextId]))
  })
}

// Shape-detected, not event-keyed — see routeWebhook's comment. Messages +
// ConversationId together are specific enough to this event that nothing
// else we handle could produce both.
function looksLikeAIGatherEnded(params) {
  return Boolean(params.Messages && params.ConversationId)
}

function handleGuidedAIGatherEnded(callSessionId, params) {
  return withJobLock(function () {
    var state = loadGuidedState(callSessionId)
    var step = state.currentStep
    var section = GUIDED_SECTIONS_BY_ID[step]

    if (!section || section.verb !== 'aigather') {
      logEvent('guided.aigather_ended_unexpected', {
        capture_id: callSessionId,
        current_step: step || '',
      })
      return texmlResponse('<Response><Hangup/></Response>')
    }

    // No documented structured-extraction field survives to this payload —
    // only the raw conversation. Feed it into the transcript the same way a
    // record-verb section's answer lands, and let runner.js's existing
    // OpenRouter extraction pass pull the actual field values out of it,
    // same as it already does for free-form sections.
    reserveSectionTranscript(state, section.id, '')
    findSectionTranscript(state, section.id).transcript = stitchAIGatherMessages(params.Messages)

    var nextId = nextSectionId(section, state)
    state.currentStep = nextId
    persistGuidedState(callSessionId, state)

    if (!nextId) {
      return texmlResponse(
        '<Response><Say voice="Telnyx.Natural.brook">Got it, that\'s everything. Hang up whenever you\'re ready.</Say></Response>',
      )
    }

    return texmlResponse(buildSectionTeXML(GUIDED_SECTIONS_BY_ID[nextId]))
  })
}

// tryJsonParse() and stitchAIGatherMessages() moved to util.js — also used
// by the Dograh path in webhook.js.

function handleGuidedRecordingStatus(callSessionId, params) {
  var step = params.step || ''
  var recordingUrl = firstParam(params, ['RecordingUrl', 'recording_url'])

  return withJobLock(function () {
    var state = loadGuidedState(callSessionId)
    reserveSectionTranscript(state, step, recordingUrl)
    persistGuidedState(callSessionId, state)
    return ContentService.createTextOutput('OK')
  })
}

function handleGuidedTranscription(callSessionId, params) {
  var step = params.step || ''
  var text = firstParam(params, ['TranscriptionText', 'transcription_text'])

  return withJobLock(function () {
    var state = loadGuidedState(callSessionId)
    var entry = findSectionTranscript(state, step)
    if (entry) {
      entry.transcript = text
    } else {
      state.sectionTranscripts.push({ step: step, transcript: text, recordingUrl: '' })
    }

    // persistGuidedState() finalizes on its own once currentStep is null and
    // every section transcript is in — the call may already have finished
    // (all sections walked) before this particular transcript lands.
    persistGuidedState(callSessionId, state)
    return ContentService.createTextOutput('OK')
  })
}

// --- TeXML builders ---

function buildSectionTeXML(section) {
  if (section.verb === 'record') return buildRecordTeXML(section)
  if (section.verb === 'gather') return buildGatherTeXML(section)
  if (section.verb === 'aigather') return buildAIGatherTeXML(section)
  throw new Error('Unknown guided section verb: ' + section.verb)
}

function buildRecordTeXML(section) {
  var actionUrl = guidedActionUrl('guided', section.id)
  var recordingStatusUrl = guidedActionUrl('guided_recording', section.id)
  var transcriptionUrl = guidedActionUrl('guided_transcription', section.id)

  return (
    '<Response>' +
    '<Say voice="Telnyx.Natural.brook">' +
    xmlEscape(section.say) +
    '</Say>' +
    '<Record' +
    ' action="' +
    xmlEscapeAttr(actionUrl) +
    '"' +
    ' method="POST"' +
    ' maxLength="' +
    (section.maxLength || 120) +
    '"' +
    // 1s, not the sub-second the dead air really calls for — Telnyx's Record
    // timeout is documented in whole seconds with no confirmed fractional
    // support. This is the tightest value that reliably applies once
    // speech is detected; it will occasionally cut off a mid-sentence
    // pause, which is the accepted trade-off against long dead air.
    ' timeout="1"' +
    ' playBeep="true"' +
    ' format="mp3"' +
    ' channels="single"' +
    ' finishOnKey="#"' +
    ' recordingStatusCallback="' +
    xmlEscapeAttr(recordingStatusUrl) +
    '"' +
    ' recordingStatusCallbackEvent="completed"' +
    ' recordingStatusCallbackMethod="POST"' +
    ' transcription="true"' +
    ' transcriptionEngine="deepgram"' +
    ' transcriptionModel="deepgram/nova-3"' +
    ' transcriptionLanguage="en-US"' +
    ' transcriptionCallback="' +
    xmlEscapeAttr(transcriptionUrl) +
    '" />' +
    '</Response>'
  )
}

function buildGatherTeXML(section) {
  var actionUrl = guidedActionUrl('guided', section.id)

  // input="dtmf speech" so a bad connection can fall back to a keypress, but
  // the prompt never announces digit options out loud — see the no-filler
  // rule in interactive-call-script.txt. numDigits="1" lets a DTMF press
  // resolve immediately instead of waiting out the speech timeout.
  return (
    '<Response>' +
    '<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="2"' +
    ' action="' +
    xmlEscapeAttr(actionUrl) +
    '" method="POST">' +
    '<Say voice="Telnyx.Natural.brook">' +
    xmlEscape(section.say) +
    '</Say>' +
    '</Gather>' +
    '</Response>'
  )
}

function buildAIGatherTeXML(section) {
  var actionUrl = guidedActionUrl('guided', section.id)

  return (
    '<Response>' +
    '<AIGather action="' +
    xmlEscapeAttr(actionUrl) +
    '" method="POST">' +
    '<Greeting>' +
    xmlEscape(section.say) +
    '</Greeting>' +
    '<Parameters><![CDATA[' +
    JSON.stringify(section.schema) +
    ']]></Parameters>' +
    '<Voice name="Telnyx.Natural.brook"/>' +
    '</AIGather>' +
    '</Response>'
  )
}

function texmlResponse(xml) {
  return ContentService.createTextOutput(
    '<?xml version="1.0" encoding="UTF-8"?>' + xml,
  ).setMimeType(ContentService.MimeType.XML)
}

// Routed through the bh-systems Worker proxy, not ScriptApp.getService().getUrl()
// directly — Apps Script's /exec endpoint always 302s to a
// script.googleusercontent.com URL for the real body, and Telnyx's mid-call
// action/callback fetches don't follow that hop. See ../../bh-systems/src/worker.js.
var TEXML_PROXY_BASE_URL = 'https://www.bh-systems.com/texml/gas'

function guidedActionUrl(event, step) {
  var base = TEXML_PROXY_BASE_URL
  return (
    base +
    '?t=' +
    encodeURIComponent(getConfig('WEBHOOK_SECRET')) +
    '&event=' +
    event +
    '&step=' +
    encodeURIComponent(step)
  )
}

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function xmlEscapeAttr(str) {
  return xmlEscape(str).replace(/"/g, '&quot;')
}

// --- result parsing ---

function applyGatherResult(callSessionId, state, section, params) {
  var digits = firstParam(params, ['Digits'])
  var speech = firstParam(params, ['SpeechResult'])
  var resolved = resolveGatherBranch(section, digits, speech)

  state.captured[section.field] = resolved.value
  if (!resolved.confident) {
    logEvent('guided.branch_ambiguous', {
      capture_id: callSessionId,
      step: section.id,
      digits: digits,
      speech: speech.slice(0, 200),
      resolved_to: resolved.value,
    })
  }
}

// roof_status is the only branch field walked through plain Gather today.
// Digits map silently to branch order (never announced — see buildGatherTeXML);
// speech falls back to keyword matching. An ambiguous "affected" answer with no
// material keyword defaults to shingle, the dominant real-world case (Phase 1
// README: 4/11 real reports skip the roof subsection entirely, but of the rest
// only one was non-shingle) — logged as ambiguous either way so the section 14
// read-back can catch a wrong guess before the call ends.
function resolveGatherBranch(section, digits, speech) {
  if (section.id !== 'roof_status') {
    throw new Error('resolveGatherBranch has no rule for section: ' + section.id)
  }

  var digitOrder = ['not_affected', 'shingle', 'other_material']
  if (digits && digitOrder[Number(digits) - 1]) {
    return { value: digitOrder[Number(digits) - 1], confident: true }
  }

  var text = String(speech || '').toLowerCase()
  if (/not affected|no damage|wasn'?t affected|\bno\b/.test(text)) {
    return { value: 'not_affected', confident: true }
  }
  if (/shingle/.test(text)) {
    return { value: 'shingle', confident: true }
  }
  if (/metal|tile|flat roof|membrane|tin|slate|rubber roof/.test(text)) {
    return { value: 'other_material', confident: true }
  }
  if (/\byes\b|yeah|affected|damage/.test(text)) {
    return { value: 'shingle', confident: false }
  }

  return { value: 'shingle', confident: false }
}

function applyAIGatherResult(callSessionId, state, section, params) {
  var parsed = parseAIGatherResult(params)
  Object.keys(parsed).forEach(function (key) {
    if (section.schema.properties[key] === undefined) return
    state.captured[key] = parsed[key]
  })

  if (Object.keys(parsed).length === 0) {
    logEvent('guided.aigather_unparsed', {
      capture_id: callSessionId,
      step: section.id,
      param_names: Object.keys(params).sort().join(','),
    })
  }
}

function parseAIGatherResult(params) {
  var raw = firstParam(params, [
    'AIGatherResult',
    'Result',
    'StructuredData',
    'Parameters',
    'AIResult',
  ])
  if (!raw) return {}

  var candidates = [raw, tryBase64Decode(raw)]
  for (var i = 0; i < candidates.length; i++) {
    var parsed = tryJsonParse(candidates[i])
    if (parsed && typeof parsed === 'object') return parsed
  }

  return {}
}

function tryBase64Decode(value) {
  try {
    return Utilities.newBlob(Utilities.base64Decode(value)).getDataAsString()
  } catch (err) {
    return ''
  }
}

// --- state persistence (Jobs sheet, `guided_state` column — see README) ---

function loadGuidedState(callSessionId) {
  var job = getJobByCaptureId(callSessionId)
  if (job && job.guided_state) {
    var parsed = tryJsonParse(job.guided_state)
    if (parsed) return parsed
  }
  return {
    flow: 'guided',
    currentStep: FIRST_GUIDED_SECTION_ID,
    captured: {},
    sectionTranscripts: [],
  }
}

// Single write path for both the in-progress state blob and the
// transcript/status fields the rest of the pipeline reads. Splitting these
// into two upsertJob calls previously let a later status write silently
// clobber an earlier one (e.g. 'pending' immediately overwritten back to
// 'awaiting_section_transcripts') — keep it one call, one decision.
function persistGuidedState(callSessionId, state) {
  var fields = { guided_state: JSON.stringify(state) }

  if (state.currentStep) {
    fields.status = 'guided_in_progress'
  } else if (allSectionTranscriptsIn(state)) {
    var transcript = stitchGuidedTranscript(state)
    fields.transcript = transcript.slice(0, 45000)
    fields.transcript_source = 'telnyx-deepgram-nova-3-guided'
    fields.transcript_chars = transcript.length
    fields.status = 'pending'
  } else {
    fields.status = 'awaiting_section_transcripts'
  }

  upsertJob(callSessionId, fields)
}

function nextSectionId(section, state) {
  if (section.branch) return section.branch[state.captured[section.field]] || null
  return section.next || null
}

function reserveSectionTranscript(state, step, recordingUrl) {
  var entry = findSectionTranscript(state, step)
  if (entry) {
    entry.recordingUrl = recordingUrl || entry.recordingUrl
    return
  }
  state.sectionTranscripts.push({ step: step, transcript: '', recordingUrl: recordingUrl || '' })
}

function findSectionTranscript(state, step) {
  for (var i = 0; i < state.sectionTranscripts.length; i++) {
    if (state.sectionTranscripts[i].step === step) return state.sectionTranscripts[i]
  }
  return null
}

// KNOWN GAP (fine for a not-yet-live scaffold, not fine to ship as-is): if a
// Record section's transcriptionCallback never arrives, this never becomes
// true and the job sits in 'awaiting_section_transcripts' forever — unlike
// the single-shot flow, which jobs.js's promoteStaleAwaitingTranscript()
// already promotes out of an equivalent stuck state after 15 minutes. Before
// this goes live, extend that sweep (or add a parallel one) to cover
// 'awaiting_section_transcripts', finalizing with whatever sections did land.
function allSectionTranscriptsIn(state) {
  return state.sectionTranscripts.every(function (entry) {
    return entry.transcript
  })
}

// Stitches every section's transcript/captured fields into the same
// `transcript` shape the single-shot flow already produces, so
// matcher.js/prompt.js/runner.js need no changes to consume a guided-flow
// job. Section labels are kept as headers so the end-of-call extraction pass
// has the same cross-section context a human reading raw notes would — see
// "Topic drift and cross-section reconciliation" in
// docs/telnyx-texml-interactive-ivr.md. Called from persistGuidedState()
// once state.currentStep is null and every section transcript is in.
function stitchGuidedTranscript(state) {
  var lines = []

  GUIDED_SECTIONS.forEach(function (section) {
    // aigather sections land their answer as a transcript too (see
    // handleGuidedAIGatherEnded) — there's no reliable structured field data
    // to prefer over it.
    var recordEntry =
      section.verb === 'record' || section.verb === 'aigather'
        ? findSectionTranscript(state, section.id)
        : null
    var capturedForSection = capturedFieldsFor(section, state.captured)

    if (!recordEntry && Object.keys(capturedForSection).length === 0) return

    lines.push('[' + section.id.toUpperCase() + ']')
    if (recordEntry && recordEntry.transcript) lines.push(recordEntry.transcript)
    Object.keys(capturedForSection).forEach(function (key) {
      lines.push(key + ': ' + capturedForSection[key])
    })
    lines.push('')
  })

  return lines.join('\n').trim()
}

function capturedFieldsFor(section, captured) {
  var fields = {}
  if (section.verb === 'gather' && section.field) {
    if (captured[section.field] !== undefined) fields[section.field] = captured[section.field]
    return fields
  }
  if (section.verb !== 'aigather') return fields

  Object.keys(section.schema.properties).forEach(function (key) {
    if (captured[key] !== undefined && captured[key] !== '') fields[key] = captured[key]
  })
  return fields
}
