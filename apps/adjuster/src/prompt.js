function buildPrompt(input) {
  var transcript = input.transcript
  var claim = input.claim
  var templateSpec = input.templateSpec || {}
  var glossary = input.glossary || []
  var phraseBank = input.phraseBank || []

  var system = [
    "You are extracting structured fields from a field adjuster's spoken dictation of a property inspection.",
    'Every field you emit must include a source_span that is an exact, contiguous substring of the transcript.',
    'If the adjuster did not say something, omit that field entirely rather than inventing or inferring a value.',
    'Anything said that does not fit a listed field goes into unplaced_notes instead of being discarded.',
    'Set confidence to "low" whenever you are not certain the source_span supports the value.',
  ].join('\n')

  var sections = [
    'Claim context:\n' + formatClaimBlock(claim),
    'Fields to extract:\n' + formatTagList(templateSpec),
  ]

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
