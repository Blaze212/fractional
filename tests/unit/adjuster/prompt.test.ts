import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildPrompt, formatFieldGuidance, formatLiveExtraction } = loadGs(
  'apps/adjuster/src/prompt.js',
)

const templateSpec = {
  roof_covering_type: {
    label: 'Roof covering type',
    type: 'enum',
    values: ['3-tab asphalt shingle', 'architectural shingle'],
  },
  roof_pitch: { label: 'Roof pitch', type: 'string' },
}

describe('buildPrompt', () => {
  it('includes the source_span requirement in the system prompt', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/source_span/)
    expect(system).toMatch(/exact/i)
  })

  it('lists every tag with its label and enum values', () => {
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

  it('instructs enum fields to send extra descriptive detail to unplaced_notes', () => {
    const { system } = buildPrompt({ transcript: 'anything', templateSpec })

    expect(system).toMatch(/unplaced_notes/)
    expect(system).toMatch(/closest matching allowed value/i)
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
    const { user } = buildPrompt({ transcript: 'anything', templateSpec })

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

  it('tells coverage_determination to choose unknown rather than guess between covered and excluded', () => {
    const spec = { coverage_determination: { label: 'Coverage determination', type: 'variant' } }

    const { user } = buildPrompt({ transcript: 't', claim: null, templateSpec: spec })

    expect(user).toContain('coverage_determination:')
    expect(user).toMatch(/"unknown" over guessing between covered and excluded/i)
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
