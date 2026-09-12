# Adjuster report narratives read as written prose

**Status:** Implemented — PR https://github.com/Blaze212/fractional/pull/55
**Owner:** Adjuster MVP
**Last updated:** 2026-09-12

## Objective

The extractor is getting the facts right and the sentences wrong. Across two
recent real calls the drafts contain a self-contradicting elevation paragraph, a
template sentence reading "a thirty-year laminate that are approximately 23 years
old", a subrogation sentence reading "the damages are no subrogation concerns
were reported", spelled-out measurements, and noun piles carried straight over
from dictation ("eight wind damage shingles"). This spec makes the narrative and
clause fields read as prose a person wrote, without loosening the `source_span`
guarantee that keeps facts honest.

## Non-goals

- Changing which facts are extracted, or any field's schema.
- Changing the `source_span` contract. A narrative's evidence still has to be a
  verbatim substring of the transcript.
- A second LLM pass to polish narratives. Considered and deferred, see below.
- Restyling the Ibis template itself.

## Business Rationale

Brandon reviews every draft before filing. A blank field costs him seconds. A
sentence that is grammatically broken, or that contradicts itself, costs more
than a blank, because he has to read the transcript to work out which half is
true. The worst examples below are not review prompts; they are text he has to
delete and rewrite.

This is also the difference between a draft that feels like a tool did most of
the work and one that feels like it has to be redone. The facts are already
right, which is the hard part.

### Observed defects

From `retell-call_4e034d77224863af06b4fc2577c` (c1) and
`retell-call_256aa200fdd679f4b7d680cb968` (c2), both `openai/gpt-5.6-luna`,
both extracted from an accepted master transcript.

**Self-contradiction inside one field.** c1 `left_elevation_status`:

> "We observed no storm-related damages on the left elevation. Approximately
> three or four linear feet of fascia was blown, wind damaged and missing and
> will need to be replaced. This appeared to be the origin of water leaking into
> the bathroom."

It opens by saying there was no damage and then describes the damage. The model
started with the stock no-damage sentence and appended the finding instead of
writing one coherent paragraph.

**A clause with a finite verb dropped into a noun-phrase slot.** c1
`origin_narrative` is `"a storm passed through the area on the day of loss"`,
which renders as:

> "Damage occurred due to a storm passed through the area on the day of loss on
> [DATE_LOSS], resulting in damage to the dwelling exterior and interior leaking."

Three defects in one sentence: the finite verb, the date paraphrase that
duplicates `[DATE_LOSS]` (the prompt forbids a date, `clauseNeedsReject` checks
for date patterns, and "on the day of loss" is neither), and a damage clause that
is not a noun phrase either.

**A clause that destroys its template sentence.** c1 `subrogation_reason` is
`"no subrogation concerns were reported"`:

> "There are no subrogation possibilities as the damages are no subrogation
> concerns were reported."

**Spoken numbers left spoken.** c1 `roof_covering_type` is `"thirty-year
laminate"` where the suggestion list offers `"30 year laminate shingles"`:

> "The shingles on the roof are a thirty-year laminate that are approximately 23
> years old."

The missing head noun makes "a thirty-year laminate that **are**" ungrammatical,
and the spelled-out number sits beside a digit in the same sentence. c2
`front_elevation_status` has the same problem in prose:

> "We observed two large glass panels, approximately sixty-six inches by sixty
> inches, and there are two of them that were damaged."

Says "two" twice, shifts tense mid-sentence, and spells out both measurements.

**A value that fights its own template.** c1 `dwelling_stories` is `"1"` while c2
gives `"1 story"`, and `dwelling_type` is `"single-family home"`:

> "The dwelling is a 1, single-family home structure."

**Requirements quietly dropped.** `overhead_profit_narrative` guidance asks for a
determination plus a claim-specific reason. c1 gives `"Overhead and profit do not
apply."` and c2 gives `"No overhead and profit considerations."` Neither carries a
reason, and c2's is a fragment. c1 `coverage_supporting_detail` is `"The
storm-created opening was confirmed."`, a restatement of the cause, which the
guidance explicitly forbids.

**Register drift inside one report.** c1 writes "no storm-related **damages**" on
all four elevations and "no storm-related **damage**" on all four slopes.

**Cross-field contradiction.** c2 sets `interior_status: not_affected` and still
fills `interior_damage_narrative` with a Main Lobby block.

### Why the prompt produces this

`prompt.js` teaches fragments on purpose. Six fields carry "start mid-sentence,
no leading capital, no trailing period" because they complete a fixed template
sentence. That instruction is correct for those fields and leaks into the ones it
should not reach. Meanwhile:

- No sentence anywhere in the system prompt says narrative fields must be
  grammatical English. The word "prose" appears, "sentence" appears in per-field
  rules, but the register is never stated.
- The slope and elevation fields, eight of them, get no prose guidance beyond
  "say so plainly".
- `roof_narrative_freeform` is the one field with a worked example, and it is
  visibly the best-written field in both drafts.
- The `source_span` discipline pulls everything toward echoing dictation, and
  nothing tells the model that a narrative is written rather than copied.
- `phraseBank` is plumbed end to end and passed as `[]` from `runner.js:280`, so
  the one channel built to carry Brandon's register carries nothing.

## Architecture

### Decision: state the two shapes as a taxonomy, at the top

Clause fields are deliberately fragments. Narrative fields are composed prose.
Both currently sit in the same undifferentiated guidance list, and both directions
of contamination are visible in the drafts: clause fields arriving as full
sentences (caught today by `clauseNeedsReject`) and narratives arriving as
clauses and fragments (caught by nothing). The taxonomy goes in the system block,
before the per-field rules.

### Decision: narratives are written, not copied

The single most direct line to add, and the one that addresses the noun-pile
defects at their root: for a narrative field the value is composed, the
`source_span` is the evidence rather than the template, and a narrative that
matches its span nearly word for word is usually wrong. This does not weaken the
span contract, which still has to hold verbatim.

### Decision: examples over rules where a rule has already failed

`roof_narrative_freeform` has an example and is the best-written field in the
sample. The eight slope and elevation fields have rules only and produced the
worst output. Add worked transcript-to-output pairs to the fields that are
failing rather than adding more prose about the rules.

### Decision: mechanical lint flags, it does not reject

`clauseNeedsReject` already rejects an unusable clause into `[NEEDS INPUT]`. A
narrative is different: a clumsy narrative still carries the facts, and replacing
it with a blank costs Brandon more than a rough sentence. So narrative lint sets
`needsReview`, which the existing highlight pass already renders, and never
blanks a field.

### Decision: no second model pass

A polish pass over narratives would be a second place facts can drift and would
break the span-to-value tie that makes the extraction auditable. Deferred until
the prompt and lint changes have been measured.

### ADR

No new ADR. Prompt wording, an unused input finally populated, and a lint that
mirrors an existing one. Spec 020's ADR already covers the clause-normalization
decision this extends.

## Implementation Phases

### Phase 0 — Prose fixtures, zero vendor calls

- Save c1 and c2's `extraction.json` and master transcripts as fixtures under
  `tests/unit/adjuster/fixtures/`.
- Add `tests/unit/adjuster/prose.test.ts` asserting today's defects are present,
  as the red baseline: the c1 subrogation clause renders its broken sentence, the
  c1 left-elevation value contains both "no storm-related damages" and a damage
  finding, the c1 origin clause renders "due to a storm passed through".
- No source changes.

### Phase 1 — The prompt states the register and the taxonomy

In `prompt.js`'s system block, before the per-field guidance:

- **Two shapes.** Clause fields complete a fixed sentence and must be fragments:
  a noun phrase, no leading capital, no finite verb of their own, no trailing
  period. Narrative fields are prose you compose and must be complete,
  grammatical sentences.
- **Narrative register.** Complete sentences with a subject and a finite verb.
  Report voice. No dictation artifacts ("okay so", "uh", "let's see"). No
  telegraphic noun piles: write "eight wind-damaged shingles", not "eight wind
  damage shingles". Numbers and measurements in digits, matching the digits
  already used elsewhere in the same sentence. One consistent register across
  parallel fields, so the four slopes and four elevations do not disagree about
  "damage" versus "damages".
- **Narratives are written, not copied**, per the Architecture decision above.
- **A field does not open with a stock denial and then contradict it.** When
  there are findings, write the findings. The no-damage sentence is for a slope
  or elevation with no findings.
- **A field whose guidance names required content is not complete without it.**
  Aimed at `overhead_profit_narrative` shedding its reason.
- Tests: `prompt.test.ts` asserts the taxonomy and register block are present,
  and that the clause-fragment instruction is scoped to clause fields.

### Phase 2 — Worked examples for the fields that have none

Add two or three short transcript-to-output pairs to the `FIELD_GUIDANCE`
entries that produced the defects, using the real dictation from c1 and c2:

- `front_slope_status` (inherited by the other three slopes): the finding case
  and the no-damage case.
- `front_elevation_status` (inherited by the other three elevations): a finding
  case built from c1's fascia dictation, showing one coherent paragraph rather
  than a denial plus an appended finding, and c2's glass-panel dictation showing
  digits and a single statement of the count.
- `overhead_profit_narrative`: a determination with a claim-specific reason.
- `origin_narrative` and `subrogation_reason`: a bad-versus-good pair each,
  since both produced a clause that broke its template sentence.
- `roof_covering_type`: note that the value completes "are a \_\_\_ that are
  approximately N years old", so it needs the head noun ("30 year laminate
  shingles", not "thirty-year laminate").
- `dwelling_stories` and `dwelling_type`: c1's "1" and "single-family home"
  render as "a 1, single-family home structure". Show "1 story" and "single
  family".

### Phase 3 — The phrase bank carries Brandon's register

- Assemble 20 to 40 sentences from Brandon's real filed reports, covering slope
  findings, elevation findings, interior room blocks, mitigation, and overhead
  and profit.
- Store as `apps/adjuster/template/phrasebank.json`, loaded the way
  `loadGlossary()` loads the glossary.
- Pass it from `runner.js:280` instead of `[]`.
- The existing prompt guard ("style reference only, do not copy facts from it")
  already covers the risk and does not change.
- Tests: the loader returns entries, the prompt renders the block, an empty or
  missing file still produces a valid prompt.

### Phase 4 — Mechanical prose lint

Add `narrativeNeedsReview(text)` to `docgen.js`, mirroring `clauseNeedsReject`'s
position in the pipeline but setting `needsReview: true` rather than blanking.
Flags a narrative that:

- has no finite verb, or does not end in terminal punctuation
- starts with a lowercase letter
- contains a dictation filler token
- contains a spelled-out number above ten where the same field carries digits
- opens with a no-damage sentence and then continues with further findings

Tests: each rule fires on its example from the c1 and c2 fixtures, a clean
narrative passes, and no rule ever empties a field.

### Phase 5 — Clause guards catch what broke the template sentences

Extend `clauseNeedsReject` in `docgen.js`:

- **Date paraphrase.** "on the day of loss", "on the date of loss", and the same
  with "that day", alongside the existing explicit-date patterns. c1's origin
  clause passed the current check and printed the date concept twice.
- **Finite verb in a noun-phrase slot.** c1's "a storm passed through the area"
  and "no subrogation concerns were reported" are both clauses with subjects and
  verbs sitting where a noun phrase belongs. A rejected clause already falls back
  to `[NEEDS INPUT: <label> — heard: "<span>"]`, which is the right outcome:
  Brandon writes one short phrase instead of deleting a broken sentence.

Tests: both c1 clauses reject; "a wind driven rain event" and "weather related"
pass; the salvage note still carries the extracted text.

## Verification

`reExtractFromArtifacts(captureId)` in `replay.js` is the verification path for
Phases 1 to 3: one OpenRouter call against the transcript already saved, no ASR,
no master merge, no phone call. Phases 4 and 5 verify for free through
`regenerateDraftFromArtifacts()`, since they operate on the rendering half.

Re-extract c1 and c2 after Phases 1 to 3 and diff the field values against the
saved artifacts. The defect list in this spec is the checklist.

## Edge Cases & Risk

| Risk                                                                           | Likelihood | Impact | Mitigation                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register instructions push the model to embellish beyond the transcript        | M          | H      | The `source_span` contract is unchanged and still verbatim-checked; Phase 0 fixtures assert no new facts appear in re-extracted values                    |
| Worked examples get copied as facts                                            | M          | M      | Existing guard wording on the phrase bank, repeated on the new examples; examples are built from calls already in the fixture set so a leak is detectable |
| Lint flags so much that `needsReview` highlighting stops meaning anything      | M          | M      | Five narrow rules, each with a fixture; measure the flag rate across the fixture set before shipping                                                      |
| Phase 5 rejects clauses that are fine, pushing more `[NEEDS INPUT]` at Brandon | M          | M      | Reject falls back to the labelled heard-citation, which is more useful than a broken sentence; passing cases are pinned by tests                          |
| Phrase bank entries carry a real insured's details                             | L          | H      | Sentences are scrubbed of names, addresses, and claim numbers when assembled; a test asserts no digit-heavy identity strings in the file                  |

## Acceptance Criteria

- [ ] `prompt.js` states the clause-versus-narrative taxonomy and the narrative
      register in the system block
- [ ] Every slope and elevation field, `overhead_profit_narrative`,
      `origin_narrative`, `subrogation_reason`, `roof_covering_type`,
      `dwelling_stories`, and `dwelling_type` carry a worked example
- [ ] `phrasebank.json` exists, loads, and is passed from `runner.js`
- [ ] `narrativeNeedsReview()` flags all five defect classes and never blanks a
      field
- [ ] `clauseNeedsReject()` rejects "a storm passed through the area on the day
      of loss" and "no subrogation concerns were reported", and still passes "a
      wind driven rain event"
- [ ] Re-extracting c1 produces an internally consistent `left_elevation_status`
      and a `roof_covering_type` carrying the head noun
- [ ] Re-extracting c2 produces a `front_elevation_status` stating the panel
      count once, with digits
- [ ] No re-extracted field contains a fact absent from its `source_span`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` pass

## Deferred

- **A narrative polish pass.** One extra call taking the narrative plus its span
  and rewriting for grammar and flow, gated by a mechanical check that no new
  proper noun or number appeared. Revisit only if the re-extraction diff after
  Phase 3 still shows fragment-shaped output.
- **Cross-field consistency checks.** c2 set `interior_status: not_affected`
  while filling `interior_damage_narrative`. That is a validation concern rather
  than a prose one, and belongs with the status-variant rules in `validate.js`.
