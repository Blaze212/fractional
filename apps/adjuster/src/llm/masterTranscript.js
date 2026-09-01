// Merges the three ASR readings of one call into a single master transcript —
// see docs/specs/012 and docs/adr/007.
//
// The load-bearing decision here is that the merge model may not author words.
// validateFields() accepts a field only when its source_span is a verbatim
// substring of the transcript, which is the codebase's strongest
// anti-hallucination guarantee. Feeding the extractor a model-authored
// transcript would quietly downgrade that to "the extractor invented nothing the
// merge model had not already invented". So the model selects among wordings the
// three ASR sources actually produced, and checkVerbatimCoverage() enforces it
// mechanically rather than trusting the prompt.

var MASTER_TRANSCRIPT_COVERAGE_ACCEPT = 0.98
var MASTER_TRANSCRIPT_COVERAGE_MIN = 0.9
// Long enough to be meaningful, short enough not to fail on legitimate
// source-switching at a phrase boundary. A guess; tune from shadow-run data.
var MASTER_TRANSCRIPT_SHINGLE_WORDS = 8
var MASTER_TRANSCRIPT_MAX_CONTESTED = 25
var MASTER_TRANSCRIPT_SPEAKERS = ['adjuster', 'agent']

var SOURCE_LABELS = {
  elevenlabs: 'ElevenLabs Scribe v2 — batch, diarized, keyterm-biased, ranked FIRST on wording',
  qwen: 'Qwen3 ASR Flash — batch, keyterm-biased, ranked SECOND on wording',
}

// The job's own live transcript, from whichever voice platform handled the
// call (see VOICE_PLATFORM_SOURCES in transcription.js) — not a fixed
// SOURCE_LABELS entry because the platform varies per job. Every precedence
// name that isn't 'elevenlabs' or 'qwen' falls back to this generic label.
var STREAMING_SOURCE_LABEL =
  "The call platform's own real-time transcript — captured live during the call. FIRST on turn structure, LAST on wording."

// The verbatim constraint, stated as an absolute. Quoted into the system prompt
// and enforced independently by checkVerbatimCoverage().
var VERBATIM_CONSTRAINT = [
  'For every passage, you must choose the wording from one of the three transcripts, character for character.',
  'You may choose different sources for different passages. You may drop a passage that is pure transcription noise.',
  "You may not write a single word that does not appear in at least one of the three transcripts, and you may not blend two sources' wordings within a phrase.",
  'Do not correct grammar, do not smooth phrasing, do not fix a word you believe all three got wrong.',
  'Speaker labels and line breaks are yours to add; the words inside a turn are not.',
].join(' ')

function buildMasterTranscriptPrompt(input) {
  var sources = input.sources || {}
  var adjusterName = input.adjusterName || 'Brandon'
  var precedence = input.precedence || SOURCE_PRECEDENCE

  var system = [
    'You are reconciling three independent machine transcriptions of one recording into a single master transcript.',
    'What this audio is: a cell-phone call placed by ' +
      adjusterName +
      ', an independent insurance field adjuster driving away from a property inspection. He is dictating what he just saw, from a moving vehicle, to an automated intake agent that asks him questions section by section. Expect road and wind noise, a lossy mobile codec, clipped starts after each agent prompt, trade jargon, spelled-out numbers ("six twelve" for a 6/12 pitch), addresses, carrier names, and proper nouns.',
    "What the three sources are, and their standing order. ElevenLabs Scribe v2 and Qwen3 ASR Flash are batch models that reprocessed the full saved recording after the call, with the claim's proper nouns and the trade glossary supplied as keyterms. The third source is the call platform's own real-time transcript, produced live during the call: it has the turn structure right because it is the only source that knows when the agent spoke, and it is the least accurate on wording because it heard each phrase once, live, at streaming latency.",
    "Resolve every disagreement in this order, ElevenLabs first, Qwen second, the call platform's live transcript last:\n" +
      [
        '- Where all three agree, use that wording.',
        "- Where ElevenLabs and Qwen agree and the call platform's live transcript differs, they are right. The live transcript disagreeing with both batch models is the expected case, not a signal.",
        "- Where ElevenLabs and Qwen disagree, prefer ElevenLabs unless the claim context or the trade glossary positively supports Qwen's reading. A name, address, carrier, or trade term that Qwen got right and ElevenLabs did not is exactly the case for overriding, and a real word in this domain beats one that is not. The live transcript agreeing with Qwen is weak corroboration and is not on its own enough to overturn ElevenLabs.",
        "- Use the live transcript's wording only where it is the sole source that produced intelligible text for that passage.",
        '- Record any passage where you had to override ElevenLabs, or where the choice was a genuine coin flip, in contested_passages.',
      ].join('\n'),
    'The verbatim constraint, which is absolute: ' + VERBATIM_CONSTRAINT,
    'Output shape: speaker-labeled turns. Use the call platform\'s live-transcript turn boundaries as the skeleton and the batch models\' wording as the content. speaker is "adjuster" for ' +
      adjusterName +
      ' and "agent" for the automated intake agent. contested_passages holds the verbatim text of any passage where the sources disagreed and the choice was a genuine coin flip; leave it empty when there were none.',
  ].join('\n\n')

  var sections = ['Claim context:\n' + formatClaimBlock(input.claim)]

  var glossaryBlock = formatGlossary(input.glossary || [])
  if (glossaryBlock) sections.push('Trade glossary:\n' + glossaryBlock)

  precedence.forEach(function (name) {
    var text = renderSourceForPrompt(name, sources[name])
    var label = SOURCE_LABELS[name] || STREAMING_SOURCE_LABEL
    if (text) sections.push('Transcript source: ' + label + '\n' + text)
  })

  return { system: system, user: sections.join('\n\n') }
}

// ElevenLabs is rendered as its diarized turns rather than as flat text, so the
// merge has something to align the call platform's live-transcript turn
// boundaries against.
function renderSourceForPrompt(name, entry) {
  if (!entry) return ''

  var text = String(entry.text || '')
  if (!text.trim()) return ''

  if (name === 'elevenlabs' && entry.turns && entry.turns.length) {
    return entry.turns
      .map(function (turn) {
        return turn.speaker + ': ' + turn.text
      })
      .join('\n')
  }

  return text
}

function buildMasterTranscriptSchema() {
  return {
    type: 'object',
    properties: {
      turns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string', enum: MASTER_TRANSCRIPT_SPEAKERS },
            text: { type: 'string' },
          },
          required: ['speaker', 'text'],
          additionalProperties: false,
        },
      },
      contested_passages: { type: 'array', items: { type: 'string' } },
    },
    required: ['turns', 'contested_passages'],
    additionalProperties: false,
  }
}

function buildMasterTranscript(input) {
  var prompt = buildMasterTranscriptPrompt(input)

  var response = callOpenRouter({
    apiKey: input.apiKey,
    model: input.model,
    fallbacks: input.fallbacks || [],
    captureId: input.captureId,
    // What the log carries for this call is the merge inputs, not one transcript.
    transcript: prompt.user,
    schemaName: 'master_transcript',
    logLabel: 'master_transcript',
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    jsonSchema: buildMasterTranscriptSchema(),
  })

  var content = response.content || {}

  return {
    turns: normalizeTurns(content.turns),
    contested_passages: capContestedPassages(content.contested_passages, input.captureId),
    model: response.model,
    usage: response.usage,
  }
}

// Merge, render, and run the coverage gate. Returns null only when the merge
// produced no turns at all; otherwise the caller reads `accepted` to decide
// whether the master or a raw fallback feeds extraction.
function buildGatedMasterTranscript(input) {
  var merge = buildMasterTranscript(input)

  if (!merge.turns.length) {
    logEvent('master_transcript.empty', { capture_id: input.captureId, model: merge.model })
    return null
  }

  var text = renderMasterTranscript(merge.turns)
  var coverage = checkVerbatimCoverage(merge.turns, input.sources)
  var accepted = coverage.coverage >= MASTER_TRANSCRIPT_COVERAGE_MIN

  if (!accepted) {
    // Rejecting rather than retrying is deliberate: a model that ignored the
    // constraint once will likely ignore it again, and every fallback target is
    // a raw ASR transcript, so the span guarantee holds unconditionally on this
    // path. The rejected master still gets written to the call folder.
    logEvent('master_transcript.verbatim_violation', {
      capture_id: input.captureId,
      coverage: coverage.coverage,
      shingles: coverage.total,
      substituted_source: selectFallbackTranscript(input.sources, input.precedence).source,
      failing_shingles: coverage.failing.join(' | ').slice(0, 1000),
    })
  } else if (coverage.coverage < MASTER_TRANSCRIPT_COVERAGE_ACCEPT) {
    logEvent('master_transcript.low_coverage', {
      capture_id: input.captureId,
      coverage: coverage.coverage,
      shingles: coverage.total,
      failing_shingles: coverage.failing.join(' | ').slice(0, 1000),
    })
  }

  return {
    accepted: accepted,
    text: text,
    turns: merge.turns,
    coverage: coverage.coverage,
    failing: coverage.failing,
    contested_passages: merge.contested_passages,
    model: merge.model,
  }
}

function normalizeTurns(turns) {
  return (turns || [])
    .filter(function (turn) {
      return turn && String(turn.text || '').trim()
    })
    .map(function (turn) {
      var speaker =
        MASTER_TRANSCRIPT_SPEAKERS.indexOf(turn.speaker) === -1 ? 'adjuster' : turn.speaker
      return { speaker: speaker, text: String(turn.text).trim() }
    })
}

function capContestedPassages(passages, captureId) {
  var all = (passages || []).map(String)
  if (all.length <= MASTER_TRANSCRIPT_MAX_CONTESTED) return all

  logEvent('master_transcript.contested_truncated', {
    capture_id: captureId || '',
    reported: all.length,
    kept: MASTER_TRANSCRIPT_MAX_CONTESTED,
  })

  return all.slice(0, MASTER_TRANSCRIPT_MAX_CONTESTED)
}

function renderMasterTranscript(turns) {
  return (turns || [])
    .map(function (turn) {
      return turn.speaker + ': ' + turn.text
    })
    .join('\n')
}

// validateFields() is handed this rather than the rendered master: a source_span
// must be evidence the adjuster actually spoke, so the speaker labels the merge
// model added are not part of the haystack. Turns stay on separate lines, which
// is what makes a span straddling a turn boundary fail — the safe direction.
function buildSpanHaystack(masterText) {
  return String(masterText || '')
    .split('\n')
    .map(function (line) {
      return line.replace(/^(adjuster|agent):\s*/, '')
    })
    .join('\n')
}

// The mechanical half of the verbatim constraint. Every 8-word window of the
// master has to appear somewhere in a source; the ratio that do is the coverage.
//
// Shingles are built per turn, not across the concatenated master. Spec 012 said
// to concatenate, but a turn boundary is exactly where the merge legitimately
// switches source, and a window straddling one is a phrase that by construction
// exists in no single source. Concatenating makes every boundary contribute
// seven guaranteed failures: on a 40-turn call that is ~280 failing shingles out
// of ~1500, which puts a perfectly faithful merge at roughly 0.81 coverage and
// under the 0.90 gate. Per turn, the guarantee is unchanged — every word inside
// a turn still has to come from a source — and the false failures go away.
function checkVerbatimCoverage(turns, sources) {
  var haystacks = Object.keys(sources || {})
    .map(function (name) {
      return normalizeForCoverage(sources[name] && sources[name].text)
    })
    .filter(function (text) {
      return text
    })

  var shingles = []

  ;(turns || []).forEach(function (turn) {
    var normalized = normalizeForCoverage(turn && turn.text)
    if (!normalized) return
    shingles = shingles.concat(
      buildShingles(normalized.split(' '), MASTER_TRANSCRIPT_SHINGLE_WORDS),
    )
  })

  if (!shingles.length) return { coverage: 0, total: 0, passed: 0, failing: [] }

  var failing = shingles.filter(function (shingle) {
    return !haystacks.some(function (haystack) {
      return haystack.indexOf(shingle) !== -1
    })
  })

  return {
    coverage: (shingles.length - failing.length) / shingles.length,
    total: shingles.length,
    passed: shingles.length - failing.length,
    failing: failing.slice(0, MASTER_TRANSCRIPT_MAX_CONTESTED),
  }
}

function normalizeForCoverage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function buildShingles(words, width) {
  if (words.length <= width) return [words.join(' ')]

  var shingles = []
  for (var i = 0; i + width <= words.length; i++) {
    shingles.push(words.slice(i, i + width).join(' '))
  }
  return shingles
}
