import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildPrompt, formatFieldGuidance, formatLiveExtraction } = loadGs(
  'apps/adjuster/src/prompt.js',
)

const templateSpec = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'string',
    suggestions: ['3-tab asphalt shingle', 'architectural shingle'],
  },
  roof_pitch: { label: 'Roof pitch', type: 'string' },
}

describe('buildPrompt', () => {
  it('includes the source_span requirement in the system prompt', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/source_span/)
    expect(system).toMatch(/exact/i)
  })

  it('lists every tag with its label and suggestion values', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).toContain('roof_covering_type')
    expect(user).toContain('Roof covering type')
    expect(user).toContain('3-tab asphalt shingle')
    expect(user).toContain('roof_pitch')
  })

  it('includes the claim context when a claim is provided', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      claim: { insured_last_name: 'Whitfield', address_line1: '412 Maple St' },
    })

    expect(user).toContain('Whitfield')
    expect(user).toContain('412 Maple St')
  })

  it('notes when no claim was matched', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec, claim: null })

    expect(user).toMatch(/no claim matched/i)
  })

  it('includes the glossary and phrase bank when provided', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      glossary: [
        {
          term: 'sistering',
          definition: 'reinforcing a joist by attaching a new one alongside it',
        },
      ],
      phraseBank: ['minor granule loss consistent with age'],
    })

    expect(user).toContain('sistering')
    expect(user).toContain('minor granule loss consistent with age')
  })

  it('omits glossary and phrase bank sections when not provided', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).not.toMatch(/trade glossary/i)
    expect(user).not.toMatch(/phrase bank/i)
  })

  it('includes the full transcript verbatim', () => {
    const transcript = 'Twelve minutes of dictation about a roof and a fence.'
    const { user } = buildPrompt({ transcript, templateSpec })

    expect(user).toContain(transcript)
  })

  it('instructs suggestion fields to send extra descriptive detail to unplaced_notes', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/unplaced_notes/)
    expect(system).toMatch(/closest suggestion captures/i)
  })

  // Phase 5: enum is retired for a "suggestions" list (see the Architecture
  // decision "suggestions, not enum") — variant keys stay a closed, exact-match
  // set, but a field with `suggestions` accepts the adjuster's own words.
  it('requires a variant value to match a listed key exactly, character for character', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/variant field/i)
    expect(system).toMatch(/exactly one of the allowed values, character for character/i)
    expect(system).toMatch(/internal keys the rendering step matches on, not prose/i)
  })

  it("tells the model a suggestions list is not closed and to use the adjuster's own words otherwise", () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/not a closed list, unlike a variant/i)
    expect(system).toMatch(/use the adjuster's own words/i)
  })

  it("lists suggestion values distinctly from a variant's allowed values in the tag list", () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).toContain(
      'roof_covering_type (string) — Roof covering type — common values (suggestions, not a closed list): 3-tab asphalt shingle, architectural shingle',
    )
  })

  it('instructs the empty-value convention instead of the impossible omit-the-field instruction', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/value "" and source_span ""/)
    expect(system).toMatch(/NEEDS INPUT/)
    expect(system).not.toMatch(/omit that field/i)
  })

  it('instructs spans to be copied verbatim including transcription errors', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/verbatim/i)
    expect(system).toMatch(/transcription errors/i)
  })

  it('forbids choosing a status variant from silence', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/affirmative statement/i)
    expect(system).toMatch(/silence/i)
  })

  it('forbids using the claim context as a source for a value the transcript never mentions', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(
      /never use it as a source for a value the transcript never actually mentions/i,
    )
  })

  it('allows the claim context to correct a garbled proper noun the transcript does mention', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/correct the spelling of a proper noun/i)
  })

  // docs/specs/022 phase 4 — the claim context is a hypothesis, not ground
  // truth, and loses its authority entirely once the adjuster's own words
  // contradict it.
  it('treats the claim context as a hypothesis that loses authority on a contradiction', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/hypothesis about which claim this is/i)
    expect(system).toMatch(/only where the adjuster's own words already corroborate/i)
    expect(system).toMatch(/loses its authority entirely/i)
    expect(system).toMatch(/claim_identity_mismatch\.mismatched to true/)
  })

  // Phase 1 (spec 023): clause fields and narrative fields are stated as two
  // distinct shapes up front, in the system block, before any per-field rule
  // relies on the distinction.
  it('states the clause-versus-narrative taxonomy in the system block', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/two shapes of extracted text/i)
    expect(system).toMatch(/no finite verb of its own, no trailing period/i)
    expect(system).toMatch(/complete, grammatical sentences with a subject and a finite verb/i)
  })

  it('states the narrative register: complete sentences, no filler, no noun piles, digits over spelled numbers', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/no dictation artifacts/i)
    expect(system).toMatch(/"eight wind-damaged shingles", not "eight wind damage shingles"/i)
    expect(system).toMatch(/numbers and measurements in digits/i)
    expect(system).toMatch(/four slopes and the four elevations should not disagree/i)
  })

  it('forbids a narrative from opening with a stock no-damage sentence and then describing damage', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(
      /does not open with a stock no-damage sentence and then go on to describe damage/i,
    )
  })

  it("says a field naming required content isn't complete without it", () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/not complete without that content/i)
  })

  it('says narratives are composed from the span, not copied from it', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/a narrative's value is composed by you, not copied/i)
    expect(system).toMatch(
      /repeats its source_span nearly word for word is usually a sign it was copied/i,
    )
  })

  it('defines a medium confidence tier that still fills the field but flags it for review', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/"medium"/i)
    expect(system).toMatch(/highlighted for a quick human check/i)
  })

  it('identifies the adjuster by a configurable name, defaulting to Brandon', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/adjuster dictating this call is Brandon/i)

    const named = buildPrompt({ transcript: 'anything', templateSpec, adjusterName: 'Ibis' })
    expect(named.system).toMatch(/adjuster dictating this call is Ibis/i)
  })

  it('omits the field-specific guidance section when no relevant tags are present', () => {
    // roof_covering_type has its own guidance (see FIELD_GUIDANCE), so use a
    // spec built entirely from unguided tags rather than the module-level
    // templateSpec fixture above.
    const spec = { some_unrelated_tag: { label: 'x', type: 'string' } }

    const { user } = buildPrompt({ transcript: 'anything', templateSpec: spec })

    expect(user).not.toMatch(/field-specific guidance/i)
  })
})

describe('field-specific guidance', () => {
  it('surfaces guidance only for tags present in templateSpec', () => {
    const spec = {
      front_slope_status: { label: 'Front slope status', type: 'narrative' },
      coinsurance_narrative: { label: 'Coinsurance', type: 'narrative' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('Field-specific guidance:')
    expect(user).toContain('front_slope_status:')
    expect(user).toContain('coinsurance_narrative:')
    expect(user).not.toContain('roof_narrative_freeform:')
  })

  it('formatFieldGuidance returns an empty string when nothing matches', () => {
    expect(formatFieldGuidance({ some_unrelated_tag: { label: 'x', type: 'string' } })).toBe('')
  })

  it('tells origin_narrative to write a mid-sentence clause and leave the date to the merge field', () => {
    const spec = { origin_narrative: { label: 'Cause of loss', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('origin_narrative:')
    expect(user).toContain('Damage occurred due to ___ on [DATE_LOSS], resulting in damage to ___.')
    expect(user).toMatch(/never the date/i)
    expect(user).toMatch(/unplaced_notes/i)
  })

  // Phase 2 (spec 023): worked transcript-to-output examples for the fields
  // that produced the worst prose in the two real-call fixtures (see
  // prose.test.ts) — a rule alone had already failed for these.
  it('shows origin_narrative a bad transcript-shaped answer against a good noun-phrase one', () => {
    const spec = { origin_narrative: { label: 'Cause of loss', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('a storm passed through the area on the day of loss')
    expect(user).toContain('a storm in the area')
    // Regression (PR #55 code review): the good example must not invent
    // facts the transcript never stated — the source_span rule this same
    // system prompt states elsewhere forbids exactly that.
    expect(user).not.toMatch(/severe wind and rain/i)
  })

  // Spec 023 paired the bad finite-verb answer with "an absence of any
  // identified subrogation potential". Spec 026 replaced that good example:
  // the template sentence already asserts there is no subrogation, so the
  // slot carries the cause, not a restatement of the negative answer.
  it('shows subrogation_reason a bad finite-verb answer against the cause clause', () => {
    const spec = { subrogation_reason: { label: 'Subrogation reason clause', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('no subrogation concerns were reported')
    expect(user).toContain('Echo the cause you extracted for origin_narrative')
    expect(user).toContain('weather related')
  })

  it('tells roof_covering_type to include the head noun so it does not collide with roof_age_years digits', () => {
    const spec = { roof_covering_type: { label: 'x', type: 'string' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('30 year laminate shingles')
    expect(user).toMatch(/not "thirty-year laminate"/i)
    // Regression (PR #55 code review): the template supplies no article
    // before this value (enums.json's roof_status "shingle" text was
    // "are a {{roof_covering_type}}", which put "a" before the plural
    // "shingles" value this guidance recommends) — the guidance must say so,
    // not just recommend a plural value that still doesn't agree.
    expect(user).toContain('The shingles on the roof are ___ that are approximately')
    expect(user).toMatch(/template supplies no article/i)
  })

  it('shows dwelling_stories and dwelling_type the defect their bare values cause together', () => {
    const spec = {
      dwelling_stories: { label: 'x', type: 'string' },
      dwelling_type: { label: 'x', type: 'string' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toMatch(/"1 story", not "1"/i)
    expect(user).toMatch(/write "single family", not "single-family home"/i)
  })

  it('gives front_slope_status a finding example and a no-damage example, both complete sentences', () => {
    const spec = { front_slope_status: { label: 'x', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('We observed eight wind-damaged shingles missing from the front slope.')
    expect(user).toContain('We observed no storm-related damage to the front slope.')
  })

  it('gives front_elevation_status one coherent paragraph instead of a denial that contradicts itself', () => {
    const spec = { front_elevation_status: { label: 'x', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toMatch(
      /one coherent paragraph, never a denial followed by a contradicting finding/i,
    )
    expect(user).toContain(
      'We observed approximately 3 to 4 linear feet of fascia on the front elevation',
    )
    // Regression: this example must stay about the front elevation — an
    // example under front_elevation_status that describes the left elevation
    // can teach the extractor to place left-elevation evidence in the front
    // field (the field's own guidance says to sort by cardinal direction).
    expect(user).not.toMatch(/on the left elevation/i)
    // Regression: the example's own output must use digits, since it sits
    // right below the "digits over spelled numbers" register rule — an
    // example that violates the rule it's illustrating teaches the wrong
    // thing by showing it.
    expect(user).not.toMatch(/three to four linear feet/i)
  })

  it('gives front_elevation_status a digits example that states a count once', () => {
    const spec = { front_elevation_status: { label: 'x', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain(
      'We observed two glass panels, approximately 66 inches by 60 inches, damaged on the front elevation.',
    )
  })

  it('tells overhead_profit_narrative a determination alone is incomplete without its reason', () => {
    const spec = { overhead_profit_narrative: { label: 'x', type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toMatch(/a determination alone is not a complete answer without its reason/i)
    expect(user).toContain('Overhead and profit do not apply.')
    expect(user).toContain('given the single-trade scope of the roofing repair')
  })

  // Phase 3: a full-sentence answer to a clause field gets rejected at render
  // time (see docgen.js's clauseNeedsReject) rather than printed as a broken
  // sentence, so the prompt reinforces the one-clause contract for every
  // field docgen normalizes as a clause.
  it.each([
    ['origin_narrative', 'Cause of loss'],
    ['origin_damage_narrative', 'Resulting damage'],
    ['coverage_cause_narrative', 'Coverage cause clause'],
    ['subrogation_reason', 'Subrogation reason clause'],
  ])('tells %s to stay mid-sentence: no leading capital, no trailing period', (tag, label) => {
    const spec = { [tag]: { label, type: 'narrative' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain(tag + ':')
    expect(user).toMatch(/no leading capital/i)
    expect(user).toMatch(/no trailing period/i)
  })

  it('tells interior_damage_narrative to write one block per room, not one paragraph', () => {
    const spec = {
      interior_damage_narrative: { label: 'Interior damage findings', type: 'narrative' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('interior_damage_narrative:')
    expect(user).toMatch(/One block per room, never one running paragraph/i)
    expect(user).toMatch(/on its own line ending in a colon/i)
  })

  it('tells other_structures_narrative to use the same per-structure shape', () => {
    const spec = {
      other_structures_narrative: { label: 'Other structures findings', type: 'narrative' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('other_structures_narrative:')
    expect(user).toMatch(/same shape as interior_damage_narrative/i)
  })

  // Phase 5: each suggestions field now names the grammatical slot it fills,
  // since a free-text value has to fit a fixed sentence.
  it.each([
    ['siding_type', 'The dwelling is wood framed with ___, and composition shingle roofing.'],
    ['occupancy_status', 'The home is currently occupied by ___.'],
    ['dwelling_type', 'The dwelling is a [stories], ___ structure.'],
    ['foundation_type', 'It was built in [year] on a ___ foundation.'],
    ['roof_covering_type', 'The shingles on the roof are ___'],
    ['roof_condition', 'The shingles are in ___ condition for their age.'],
    ['roof_pitch', 'The slopes on the roof are pitched at ___.'],
  ])('names the grammatical slot %s fills', (tag, fixedSentenceFragment) => {
    const spec = { [tag]: { label: 'x', type: 'string', suggestions: ['a'] } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain(tag + ':')
    expect(user).toContain(fixedSentenceFragment)
  })

  it('tells coverage_determination to choose unknown rather than guess between covered and excluded', () => {
    const spec = { coverage_determination: { label: 'Coverage determination', type: 'variant' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('coverage_determination:')
    expect(user).toMatch(/"unknown" over guessing between covered and excluded/i)
  })

  // Phase 4: coverage_supporting_detail guidance is written by exclusion so the
  // model stops filling it with a restatement of the cause or the determination
  // — the sentence that used to say the same thing three times.
  it('tells coverage_supporting_detail to hold only an independent fact, not a restated cause or determination', () => {
    const spec = {
      coverage_supporting_detail: { label: 'Coverage supporting detail', type: 'narrative' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('coverage_supporting_detail:')
    expect(user).toMatch(/independent policy fact/i)
    expect(user).toMatch(/not itself a restatement of the cause/i)
    expect(user).toMatch(/do not say the claim is or is not covered/i)
  })

  it('tells present_at_inspection to resolve a bare role to a name stated elsewhere in the call', () => {
    const spec = {
      present_at_inspection: { label: 'Present at inspection', type: 'string' },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('present_at_inspection:')
    expect(user).toMatch(/resolve the role to the named individual/i)
  })
})

// A Q&A intake agent asks each section as a question, so the normal "this
// section does not apply" answer arrives as a bare "No" in the adjuster's turn.
// The agent's question carries the context and is deliberately absent from the
// span haystack (buildSpanHaystack, spec 022), so these three fields used to
// have no reachable negative path at all.
describe('negative answers to the intake agent section questions', () => {
  it('counts a one-word answer as the affirmative statement a status variant needs', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/A direct answer to a direct question is an affirmative statement/i)
    expect(system).toContain('cite his own answer turn as the source_span')
    // Silence still has to stay a miss, or the rule has swallowed its own point.
    expect(system).toMatch(/Silence is what does not count/i)
  })

  it('routes a negative mitigation answer to the canned none branch', () => {
    const { user } = buildPrompt({
      transcript: 't',
      claim: null,
      templateSpec: { mitigation_status: { label: 'Mitigation status', type: 'variant' } },
    })

    expect(user).toContain('mitigation_status:')
    expect(user).toContain('No mitigation services were performed on this loss.')
    expect(user).toMatch(/needs no mitigation_narrative behind it/i)
  })

  it('lets a bare no stand as a complete overhead and profit determination', () => {
    const { user } = buildPrompt({
      transcript: 't',
      claim: null,
      templateSpec: {
        overhead_profit_narrative: { label: 'Overhead & profit', type: 'narrative' },
      },
    })

    expect(user).toContain('Overhead and profit are not included on this loss.')
    expect(user).toMatch(/is itself his determination and is complete as it stands/i)
    // The reason requirement survives for the case it was written for.
    expect(user).toContain('A determination alone is not a complete answer without its reason')
  })

  it('routes a negative interior answer to the not_affected branch', () => {
    const { user } = buildPrompt({
      transcript: 't',
      claim: null,
      templateSpec: { interior_status: { label: 'Interior status', type: 'variant' } },
    })

    expect(user).toContain('interior_status:')
    expect(user).toContain('The dwelling interior was not affected during this loss.')
    expect(user).toMatch(/needs no interior_damage_narrative behind it/i)
    // The whole point of choosing this over an emptyText fallback: an interior
    // nobody raised still reaches the adjuster as [NEEDS INPUT] rather than
    // asserting a finding he never made.
    expect(user).toMatch(/silence is not a "not_affected" answer/i)
  })

  it('names interior among the status variants the one-word rule covers', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    // The rule is scoped by an explicit list, so interior only inherits it by
    // being in that list — spec 026 shipped without it, which is the bug.
    expect(system).toContain('Status variants (roof, exterior, interior,')
  })

  it('sends the subrogation slot to the cause of loss, not to the negative answer', () => {
    const { user } = buildPrompt({
      transcript: 't',
      claim: null,
      templateSpec: { subrogation_reason: { label: 'Subrogation reason', type: 'narrative' } },
    })

    expect(user).toMatch(/does not belong in this slot at all/i)
    expect(user).toContain('Echo the cause you extracted for origin_narrative')
    // The old fallback produced "the damages are an absence of any identified
    // subrogation potential", which is what this replaced.
    expect(user).not.toContain('an absence of any identified subrogation potential')
  })
})

describe('variant fields in the tag list', () => {
  it('lists allowed variant keys, which validateFields matches on exactly', () => {
    const spec = {
      mortgage_status: {
        type: 'variant',
        label: 'Mortgage',
        values: [
          { key: 'has_mortgage', text: 'a' },
          { key: 'no_mortgage', text: 'b' },
        ],
      },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('allowed values: has_mortgage, no_mortgage')
  })

  it('does not leak the rendered variant text into the field list', () => {
    const spec = {
      mortgage_status: {
        type: 'variant',
        values: [{ key: 'has_mortgage', text: 'I confirmed the mortgage is through X.' }],
      },
    }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).not.toContain('I confirmed the mortgage is through X.')
  })
})

describe('live extraction (Dograh Notetaker / calendar cross-check)', () => {
  it('omits the section entirely when no live extraction is provided', () => {
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(user).not.toMatch(/reference data/i)
  })

  it('lists live-extracted values and instructs the model to cross-check them against the transcript', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      liveExtraction: { roof_covering_type: 'architectural shingle', roof_pitch: '6/12' },
    })

    expect(user).toMatch(/reference data/i)
    expect(user).toContain('roof_covering_type: architectural shingle')
    expect(user).toContain('roof_pitch: 6/12')
    expect(user).toMatch(/cross-check every value/i)
    expect(user).toMatch(/never copy one of these values into a field without transcript evidence/i)
  })

  it('drops empty and blank live-extraction values instead of listing them', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      liveExtraction: { roof_covering_type: '', roof_pitch: undefined },
    })

    expect(user).not.toMatch(/reference data/i)
  })

  it('never leaks call metadata riding alongside the mirrored tag fields', () => {
    const { user } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      liveExtraction: {
        roof_pitch: '6/12',
        capture_id: 'dograh-abc123',
        transcript_url: 'https://example.com/t.json',
        call_disposition: 'completed',
      },
    })

    expect(user).not.toContain('dograh-abc123')
    expect(user).not.toContain('transcript_url')
    expect(user).not.toContain('call_disposition')
  })

  it('formatLiveExtraction returns an empty string when nothing is provided', () => {
    expect(formatLiveExtraction(null, templateSpec)).toBe('')
    expect(formatLiveExtraction({}, templateSpec)).toBe('')
  })
})

describe('transcript source framing', () => {
  it('tells the model the master is reconciled and that spans must stay inside one turn', () => {
    const { system } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: 'master',
    })

    expect(system).toContain('master transcript')
    expect(system).toContain('no wording was authored during reconciliation')
    expect(system).toContain('entirely within a single turn')
  })

  // docs/specs/022 phase 4 — the master transcript's haystack (buildSpanHaystack)
  // is adjuster turns only; the prompt states the same rule explicitly rather
  // than leaving it as an unstated property of the input.
  it('tells the model a span never comes from the agent (spec 022)', () => {
    const { system } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: 'master',
    })

    expect(system).toMatch(/never evidence for a value/i)
    expect(system).toContain('never cite one')
  })

  // resolveExtractionTranscript passes the full master (transcript) to the
  // model and only the adjuster-turn projection (haystack) to validateFields —
  // see transcription.test.ts's 'strips speaker labels for the span haystack'.
  // The framing used to tell the model the agent's turns had been removed,
  // which is not what it receives; a short answer is unreadable without the
  // question it answers, so the framing now describes what is actually there.
  it('tells the model both speakers are present, and to read the agent for context', () => {
    const { system } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: 'master',
    })

    expect(system).toContain('Both speakers are present and labelled')
    expect(system).toMatch(/which question a short answer belongs to/i)
    expect(system).not.toContain("agent's turns removed")
  })

  it.each([
    ['elevenlabs', 'ElevenLabs Scribe v2'],
    ['qwen', 'Qwen3 ASR Flash'],
  ])('names %s as the single source on a fallback path', (source, label) => {
    const { system } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: source,
    })

    expect(system).toContain(label)
    // The turn rule only applies to the master; a raw transcript is flat text.
    expect(system).not.toContain('entirely within a single turn')
  })

  it('describes the Dograh transcript as the real-time one', () => {
    const { system } = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: 'dograh',
    })

    expect(system).toContain('real-time streaming transcription')
    expect(system).not.toContain('entirely within a single turn')
  })

  it('describes the Retell transcript identically to the Dograh one', () => {
    const dograh = buildPrompt({ transcript: 'anything', templateSpec, transcriptSource: 'dograh' })
    const retell = buildPrompt({ transcript: 'anything', templateSpec, transcriptSource: 'retell' })

    expect(retell.system).toContain('real-time streaming transcription')
    expect(retell.system).not.toContain('entirely within a single turn')
    expect(retell.system).toBe(dograh.system)
  })

  it('leaves the prompt exactly as it was when no source is named (Telnyx)', () => {
    const withoutSource = buildPrompt({ transcript: 'anything', templateSpec })
    const withEmptySource = buildPrompt({
      transcript: 'anything',
      templateSpec,
      transcriptSource: '',
    })

    expect(withoutSource.system).toBe(withEmptySource.system)
    expect(withoutSource.system).not.toContain('master transcript')
    expect(withoutSource.system).not.toContain('ElevenLabs')
  })
})
