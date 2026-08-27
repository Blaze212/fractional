// What the extractor is actually reading. Keyed by what resolveExtractionTranscript
// (transcription.js) resolved to; a Telnyx job has no entry here and gets the
// unchanged prompt. The turn-bounded-span sentence applies only to the merged
// master, since it is the only input with turns — a raw fallback transcript is
// flat text and the span haystack is simply that transcript.
var TRANSCRIPT_SOURCE_FRAMING = {
  master:
    "The transcript below is a master transcript: three independent machine transcriptions of the same recording — two batch models and the call's own real-time stream — reconciled into one and labelled turn by turn. Every word in it was produced by one of those transcriptions; no wording was authored during reconciliation, so it is still machine-transcribed audio and the source_span rule applies to it unchanged. A source_span must lie entirely within a single turn: never build one that runs across a turn boundary or that includes a speaker label.",
  elevenlabs:
    'The transcript below is a single batch machine transcription of the call recording (ElevenLabs Scribe v2), re-read from the saved audio after the call. It is flat text with no speaker labels or turn structure.',
  qwen: 'The transcript below is a single batch machine transcription of the call recording (Qwen3 ASR Flash), re-read from the saved audio after the call. It is flat text with no speaker labels or turn structure.',
  dograh:
    "The transcript below is the call's real-time streaming transcription, produced live during the call as the adjuster spoke.",
}

function buildPrompt(input) {
  var transcript = input.transcript
  var claim = input.claim
  var templateSpec = input.templateSpec || {}
  var glossary = input.glossary || []
  var phraseBank = input.phraseBank || []
  var liveExtraction = input.liveExtraction || null
  var adjusterName = input.adjusterName || 'Brandon'
  var transcriptSource = input.transcriptSource || ''

  var system = [
    "You are extracting structured fields from a field adjuster's spoken dictation of a property inspection. Your output pre-fills a report draft the adjuster reviews before filing: a field you leave empty costs him a few seconds of review, a field you guess wrong can end up in a filed insurance report.",
    'The transcript is an automated voice-to-text transcription of a phone call. Expect mis-transcribed words, missing or odd punctuation, and numbers spelled out as words ("six twelve" for a 6/12 pitch, "twenty-one fifty" for 2,150). Use the trade glossary to recognize garbled trade terms.',
    'The adjuster dictating this call is ' +
      adjusterName +
      '. When the transcript uses "I" or "me" for the person narrating, that is ' +
      adjusterName +
      '. He is always the one who did the inspection, so do not list him as a present_at_inspection attendee just because he was there to dictate the call — only name him there if the transcript explicitly counts him among who was present the same way it would any other named individual.',
    'Extract only what the adjuster actually said. Never fill a field from inference, typical values, or outside knowledge. The response format requires every field to be present, so when the adjuster did not state a field, return it with value "" and source_span "" — empty fields are rendered as highlighted [NEEDS INPUT] markers for his review, which is always the correct outcome when the transcript is silent.',
    'Every filled field must include a source_span that is an exact, contiguous substring of the transcript. Copy it verbatim, including any transcription errors — do not paraphrase, correct, or splice separate sentences together. A span that does not appear in the transcript character for character (whitespace aside) invalidates the whole field. Use the shortest span that contains the evidence for the value.',
    'The value may normalize the spoken form found in the span (spelled-out numbers to digits, "six twelve" to "6/12") but must never add facts the span does not state. Narrative fields are written in the report\'s first-person-plural voice ("We observed...", "We will estimate to repair..."); their source_span is the contiguous passage of the transcript they are drawn from, and every fact in the narrative must appear in that passage.',
    'Set confidence to "high" only when the source_span states the value directly and unambiguously. Set it to "medium" when you are confident in the value but had to do a small amount of work to get there — resolving a role reference (e.g. "the tenant") to a name stated elsewhere in the call, normalizing a mis-transcribed proper noun against the claim context, a safe arithmetic or date computation, or a close enum match. Medium-confidence fields are still filled in on the report, just highlighted for a quick human check. Set it to "low" whenever you are genuinely torn between two plausible readings or the evidence is too garbled to trust — low-confidence fields are routed to the adjuster for full confirmation instead of being filled in, so when torn between low and anything else, choose "low".',
    'For enum and variant fields, value must be exactly one of the allowed values, character for character. Choose the closest matching allowed value only when the transcript clearly supports it; if nothing said reasonably maps to any allowed value, return the field empty instead of forcing a bad fit. If the transcript includes descriptive detail beyond what the closest value captures (e.g. "a 1 story with a room over the garage"), put the extra detail in unplaced_notes rather than distorting the enum choice or dropping the detail.',
    'Status variants (roof, exterior, personal property, mitigation, mortgage) require an affirmative statement — "the roof was not affected", "there is no mortgage" — before you choose a value. Silence about a section is not evidence of "none" or "not_affected"; return the field empty instead.',
    'Anything said that does not fit a listed field goes into unplaced_notes instead of being discarded — common examples include dates (received, contacted, inspected, date of loss — these are merge fields filled outside this pipeline, not extraction targets), claim numbers, carrier names, tree removal, business personal property, additional living expense, loss of use, and references to a prior/previous claim. Write each note as one short, self-contained sentence the adjuster can act on.',
    TRANSCRIPT_SOURCE_FRAMING[transcriptSource] || '',
    'The claim context identifies which claim this call was matched to. Use it to interpret references ("the insured", "the property") and to correct the spelling of a proper noun the transcript clearly refers to but a transcription error garbled — e.g. a contact\'s name or a carrier that is a near-miss for one in the claim context. When the claim context includes an exact-match insured name, treat that spelling as authoritative over anything the call\'s voice-to-text produced — the insured\'s own name should never ride on transcription accuracy. Never use it as a source for a value the transcript never actually mentions. If the transcript names a different insured, address, or carrier than the claim context, add an unplaced_notes entry flagging the possible mismatch instead of silently overriding it.',
  ]
    .filter(function (line) {
      return line
    })
    .join('\n')

  var sections = [
    'Claim context:\n' + formatClaimBlock(claim),
    'Fields to extract:\n' + formatTagList(templateSpec),
  ]

  var fieldGuidanceBlock = formatFieldGuidance(templateSpec)
  if (fieldGuidanceBlock) sections.push('Field-specific guidance:\n' + fieldGuidanceBlock)

  var glossaryBlock = formatGlossary(glossary)
  if (glossaryBlock) sections.push('Trade glossary:\n' + glossaryBlock)

  var phraseBankBlock = formatPhraseBank(phraseBank)
  if (phraseBankBlock)
    sections.push(
      'Phrase bank (style reference only, do not copy facts from it):\n' + phraseBankBlock,
    )

  sections.push('Transcript:\n' + transcript)

  var liveExtractionBlock = formatLiveExtraction(liveExtraction, templateSpec)
  if (liveExtractionBlock) {
    sections.push(
      [
        'Reference data (per-field values captured before or during the call — either live, per question, by a separate assistant during the call, or noted on the calendar invite before the call):',
        liveExtractionBlock,
        'Cross-check every value above against the transcript. Where the transcript supports a value, extract it yourself from the transcript with a real source_span — never copy one of these values into a field without transcript evidence for it. Treat this list only as a hint for what to listen for, not as a source of truth on its own; where it disagrees with the transcript, the transcript wins.',
      ].join('\n'),
    )
  }

  return { system: system, user: sections.join('\n\n') }
}

// liveExtraction merges two hint sources, both keyed by the same tag names as
// templateSpec: Dograh Notetaker's raw per-field export from this call (see
// webhook.js's handleDograhNotetaker), and calendar_fields noted on the
// appointment before the call ever happened (see calendarSync.js). Filtered to
// templateSpec's keys so call metadata riding along in the same object
// (capture_id, transcript_url, call_disposition, ...) never leaks into the prompt.
function formatLiveExtraction(liveExtraction, templateSpec) {
  if (!liveExtraction) return ''

  var lines = Object.keys(templateSpec)
    .filter(function (tag) {
      var value = liveExtraction[tag]
      return value !== undefined && value !== null && value !== ''
    })
    .map(function (tag) {
      return '- ' + tag + ': ' + liveExtraction[tag]
    })

  return lines.join('\n')
}

// Guidance for specific tags, only surfaced when that tag is actually part of the
// schema being extracted — keeps the prompt proportional to whatever templateSpec
// is passed in rather than always dumping every section's guidance.
var FIELD_GUIDANCE = {
  present_at_inspection:
    'If the transcript identifies who was present only by role ("the tenant", "the property manager", "her son") without naming them, and that person\'s name is stated anywhere else in the call (e.g. during the assignment/contact discussion), resolve the role to the named individual and use their name here instead of the role. Use the source_span of the sentence that places them at the inspection, and set confidence to "medium" since this connects two separate mentions rather than reading one directly. If no name is ever given for that role anywhere in the transcript, keep the role phrase as said (e.g. "the tenant").',
  present_at_inspection_verb:
    'Set to "was" if present_at_inspection names exactly one person, "were" if it names more than one. Real filed reports often write "was" regardless of count — conjugate correctly anyway rather than copying that habit. Reuse the source_span of present_at_inspection since this field is derived from it.',
  origin_narrative:
    "The cause-of-loss story as report prose: what happened, when, how the damage spread, and any official determination (e.g. fire department findings) — the cause only, not what was damaged as a result (that's origin_damage_narrative). Only facts the adjuster stated.",
  origin_damage_narrative:
    'What was actually damaged as a result of the cause described in origin_narrative — the specific items, rooms, or areas affected, as report prose. Only facts the adjuster stated; do not restate the cause here, only the resulting damage.',
  roof_age_years:
    'A number of years as digits (e.g. "12"), not an install year. The adjuster\'s own hedged estimate ("I\'d guess about twelve years") is still his estimate — extract it with high confidence; use low confidence only when you had to compute the age yourself (e.g. from an install year).',
  mitigation_narrative:
    'Cover who responded, what emergency work was performed, and what is still running or pending, in report prose.',
  soft_metal_status:
    'Findings about soft metals only — drip edge, flashing, vents, gutters, pipe boots — not slope shingle damage. Leave this unextracted (do not write "none" or "no damage found") when the adjuster said nothing about soft metals; the field renders blank rather than [NEEDS INPUT] when left out, which is the correct outcome for a slope/component that was never discussed.',
  front_slope_status:
    'Findings for the front slope only. The adjuster narrates the roof as one continuous description and may identify a slope by compass direction ("the north side") rather than "front" — infer which cardinal slope is meant from context (e.g. the dwelling\'s orientation as discussed elsewhere in the call) and sort the finding into the matching front/right/back/left field; if the mapping is genuinely ambiguous, leave it unextracted and route the finding to unplaced_notes instead of guessing. If the transcript uses a compound label for this slope ("upper front slope", "front slope with extension"), fold it in here rather than dropping it. If the transcript explicitly states there was no damage on this slope, say so plainly; if the slope is never mentioned at all, leave the field unextracted instead of writing a "no damage" sentence — the field renders blank either way, but only inventing coverage of a slope nobody discussed is the failure mode to avoid.',
  right_slope_status: 'Same rule as front_slope_status, for the right slope.',
  back_slope_status: 'Same rule as front_slope_status, for the back slope.',
  left_slope_status:
    'Same rule as front_slope_status, for the left slope. Anything the adjuster said about the roof that does not fit soft metals or one of the four cardinal slopes (e.g. an odd fifth slope, a general condition remark) goes in unplaced_notes instead of being forced into one of these fields.',
  roof_narrative_freeform:
    'The roof is not a shingle roof, so write the full passage yourself: covering material and age, condition, layer count, and pitch, then per-slope findings (every slope mentioned, including undamaged ones), then a repair-or-replace conclusion. Example shape, adapt to the actual transcript rather than copying it: "The roof has Metal roofing with a layer of asphalt shingles underneath that are approximately 20 years old. The panels are in average condition for their age. There is one layer of metal panels and two layers of shingles underneath the metal panels with no drip edge present. The slopes on the roof are pitched at 5/12. My inspection of the roof found no storm related damages present. However, we did observe two raised nails on the left extension ridge which could be the water intrusion point. Since no storm related damages were found to the roof surface, we did not include any repairs in our estimate."',
  front_elevation_status:
    'Findings for the front elevation only. The adjuster narrates the exterior as one continuous description and may identify an elevation by compass direction ("the north side") rather than "front" — infer which cardinal elevation is meant from context (e.g. the dwelling\'s orientation as discussed elsewhere in the call) and sort the finding into the matching front/right/back/left field; if the mapping is genuinely ambiguous, leave it unextracted and route the finding to unplaced_notes instead of guessing. If the transcript explicitly states there was no damage on this elevation, say so plainly; if this elevation is never mentioned at all, leave the field unextracted instead of writing a "no damage" sentence — the field renders blank either way, but only inventing coverage of an elevation nobody discussed is the failure mode to avoid.',
  right_elevation_status: 'Same rule as front_elevation_status, for the right elevation.',
  back_elevation_status: 'Same rule as front_elevation_status, for the back elevation.',
  left_elevation_status: 'Same rule as front_elevation_status, for the left elevation.',
  interior_damage_narrative:
    'If the transcript describes a multi-level property, group rooms under level sub-headers ("Main Level", "Upper Level", "Basement Level") before listing the rooms on that level, rather than listing all rooms flat. If flooring damage in one room extends into an open-plan adjoining room, say so explicitly rather than listing the adjoining room as a separate, unrelated item.',
  personal_property_narrative:
    'Three cases: (1) the transcript lists specific damaged items — write them out; (2) the adjuster explicitly says they are unsure of the extent and will need additional inspection — use that deferred phrasing, do not invent a list; (3) damage is mentioned but nothing is itemized — leave this field unextracted (do not guess at items) so it gets flagged for manual input.',
  overhead_profit_narrative:
    'State a determination (not included / included / not yet, but likely) plus a claim-specific reason (number of trades involved, scope of work, caliber of home). If coverage_determination is "excluded", use "Due to the coverage issue, overhead and profit do not appear to be applicable to this loss." instead of reasoning about trades or scope.',
  subrogation_reason:
    'Normally just the reason clause completing "There are no subrogation possibilities as the damages are ___." (e.g. "weather related", "related to a 10 year old plumbing supply line that was not recently repaired"). If the transcript describes an unusual subrogation argument that does not fit this clause shape (e.g. a warranty-based argument), do not rewrite the whole sentence yourself — leave this field unextracted so Brandon writes it by hand.',
  coinsurance_narrative:
    'Coinsurance applies to almost no claims — only extract this field when the transcript explicitly states coinsurance figures or that a coinsurance penalty applies. Otherwise leave it unextracted.',
  coverage_cause_narrative:
    'A short clause describing why the damage is or is not covered (e.g. "storm related", "related to a burst plumbing line due to freezing", "related to an accidental discharge of water from within a plumbing system"). Echo the cause already described in origin_narrative, worded for a coverage sentence.',
  coverage_supporting_detail:
    'Optional — only fill this in when the adjuster states something that directly supports the coverage determination beyond the cause itself, e.g. confirming heat was maintained in the home for a freeze claim. Leave unextracted otherwise.',
}

function formatFieldGuidance(templateSpec) {
  var lines = Object.keys(FIELD_GUIDANCE)
    .filter(function (tag) {
      return Object.prototype.hasOwnProperty.call(templateSpec, tag)
    })
    .map(function (tag) {
      return '- ' + tag + ': ' + FIELD_GUIDANCE[tag]
    })
  return lines.join('\n')
}

function formatClaimBlock(claim) {
  if (!claim) return 'No claim matched. Leave claim-identifying fields as needing input.'

  return Object.keys(claim)
    .map(function (key) {
      return '- ' + key + ': ' + claim[key]
    })
    .join('\n')
}

function formatTagList(templateSpec) {
  return Object.keys(templateSpec)
    .map(function (tag) {
      var def = templateSpec[tag]
      var descriptor = '- ' + tag + ' (' + def.type + ')'
      if (def.label) descriptor += ' — ' + def.label
      if (def.type === 'enum' && def.values)
        descriptor += ' — allowed values: ' + def.values.join(', ')
      // Variant values are {key, text} pairs and the key is what validateFields
      // matches on. Listing only enum values left the model guessing variant keys
      // it had never been shown, so every variant field came back needing input.
      if (def.type === 'variant' && def.values)
        descriptor +=
          ' — allowed values: ' +
          def.values
            .map(function (option) {
              return option.key
            })
            .join(', ')
      return descriptor
    })
    .join('\n')
}

function formatGlossary(glossary) {
  if (!glossary.length) return ''
  return glossary
    .map(function (entry) {
      return '- ' + entry.term + ': ' + entry.definition
    })
    .join('\n')
}

function formatPhraseBank(phraseBank) {
  if (!phraseBank.length) return ''
  return phraseBank
    .map(function (phrase) {
      return '- ' + phrase
    })
    .join('\n')
}
