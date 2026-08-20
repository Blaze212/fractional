function buildPrompt(input) {
  var transcript = input.transcript
  var claim = input.claim
  var templateSpec = input.templateSpec || {}
  var glossary = input.glossary || []
  var phraseBank = input.phraseBank || []

  var system = [
    "You are extracting structured fields from a field adjuster's spoken dictation of a property inspection. Your output pre-fills a report draft the adjuster reviews before filing: a field you leave empty costs him a few seconds of review, a field you guess wrong can end up in a filed insurance report.",
    'The transcript is an automated voice-to-text transcription of a phone call. Expect mis-transcribed words, missing or odd punctuation, and numbers spelled out as words ("six twelve" for a 6/12 pitch, "twenty-one fifty" for 2,150). Use the trade glossary to recognize garbled trade terms.',
    'Extract only what the adjuster actually said. Never fill a field from inference, typical values, or outside knowledge. The response format requires every field to be present, so when the adjuster did not state a field, return it with value "" and source_span "" — empty fields are rendered as highlighted [NEEDS INPUT] markers for his review, which is always the correct outcome when the transcript is silent.',
    'Every filled field must include a source_span that is an exact, contiguous substring of the transcript. Copy it verbatim, including any transcription errors — do not paraphrase, correct, or splice separate sentences together. A span that does not appear in the transcript character for character (whitespace aside) invalidates the whole field. Use the shortest span that contains the evidence for the value.',
    'The value may normalize the spoken form found in the span (spelled-out numbers to digits, "six twelve" to "6/12") but must never add facts the span does not state. Narrative fields are written in the report\'s first-person-plural voice ("We observed...", "We will estimate to repair..."); their source_span is the contiguous passage of the transcript they are drawn from, and every fact in the narrative must appear in that passage.',
    'Set confidence to "high" only when the source_span states the value directly. Set it to "low" whenever you interpreted a garbled word, did arithmetic or date reasoning, picked an approximate enum match, or chose between two plausible readings — low-confidence fields are routed to the adjuster for confirmation, so when torn between the two, choose "low".',
    'For enum and variant fields, value must be exactly one of the allowed values, character for character. Choose the closest matching allowed value only when the transcript clearly supports it; if nothing said reasonably maps to any allowed value, return the field empty instead of forcing a bad fit. If the transcript includes descriptive detail beyond what the closest value captures (e.g. "a 1 story with a room over the garage"), put the extra detail in unplaced_notes rather than distorting the enum choice or dropping the detail.',
    'Status variants (roof, exterior, personal property, mitigation, mortgage) require an affirmative statement — "the roof was not affected", "there is no mortgage" — before you choose a value. Silence about a section is not evidence of "none" or "not_affected"; return the field empty instead.',
    'Anything said that does not fit a listed field goes into unplaced_notes instead of being discarded — common examples include dates (received, contacted, inspected, date of loss — these are merge fields filled outside this pipeline, not extraction targets), claim numbers, carrier names, tree removal, business personal property, additional living expense, loss of use, and references to a prior/previous claim. Write each note as one short, self-contained sentence the adjuster can act on.',
    'The claim context identifies which claim this call was matched to. Use it to interpret references ("the insured", "the property") — never as a source for field values. If the transcript names a different insured or address than the claim context, add an unplaced_notes entry flagging the possible mismatch.',
  ].join('\n')

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

  return { system: system, user: sections.join('\n\n') }
}

// Guidance for specific tags, only surfaced when that tag is actually part of the
// schema being extracted — keeps the prompt proportional to whatever templateSpec
// is passed in rather than always dumping every section's guidance.
var FIELD_GUIDANCE = {
  present_at_inspection_verb:
    'Set to "was" if present_at_inspection names exactly one person, "were" if it names more than one. Real Ibis reports often write "was" regardless of count — conjugate correctly anyway rather than copying that habit. Reuse the source_span of present_at_inspection since this field is derived from it.',
  mortgage_company:
    'The lender name only (e.g. "Chase", not "financed through Chase"). If the adjuster confirms a mortgage but the lender name is missing or too garbled to read confidently, return this field empty so it flags for review — never guess a lender.',
  origin_narrative:
    'The cause-of-loss story as report prose: what happened, when, how the damage spread, and any official determination (e.g. fire department findings) — only facts the adjuster stated.',
  roof_age_years:
    'A number of years as digits (e.g. "12"), not an install year. The adjuster\'s own hedged estimate ("I\'d guess about twelve years") is still his estimate — extract it with high confidence; use low confidence only when you had to compute the age yourself (e.g. from an install year).',
  mitigation_narrative:
    'Cover who responded, what emergency work was performed, and what is still running or pending, in report prose.',
  roof_damage_narrative:
    'List every slope you have information about, including slopes with no damage ("We did not observe any storm related damages on this slope."); do not omit undamaged slopes. Use whatever slope labels the transcript uses (e.g. "Front Slope", "Upper Front Slope", "Front Slope with Extension", a "Soft Metals" line) rather than forcing a fixed Front/Right/Back/Left layout. End with a repair-or-replace conclusion tied to the specific slope(s) and square footage found damaged.',
  roof_narrative_freeform:
    'The roof is not a shingle roof, so write the full passage yourself: covering material and age, condition, layer count, and pitch, then per-slope findings (every slope mentioned, including undamaged ones), then a repair-or-replace conclusion. Example shape, adapt to the actual transcript rather than copying it: "The roof has Metal roofing with a layer of asphalt shingles underneath that are approximately 20 years old. The panels are in average condition for their age. There is one layer of metal panels and two layers of shingles underneath the metal panels with no drip edge present. The slopes on the roof are pitched at 5/12. My inspection of the roof found no storm related damages present. However, we did observe two raised nails on the left extension ridge which could be the water intrusion point. Since no storm related damages were found to the roof surface, we did not include any repairs in our estimate."',
  exterior_narrative:
    'Cover all four elevations — Front, Right, Back, Left, in that order — even the ones with no damage ("We did not observe any storm related damages on this elevation."). Do not skip an elevation just because nothing was found on it.',
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
