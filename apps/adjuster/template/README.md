# Phase 0 template — design notes for review

`enums.json` and `template.flattened.txt` are a first pass, built by parsing
`ibis-report-template-original.docx` and cross-checking every field against
the 13 finished reports (read from `voice-to-report-generator/` locally —
never committed; see the repo `.gitignore`). Flag anything below that's
wrong; this is exactly the kind of gap the spec expects on a first pass.

## Corrections made against the blank template

The blank docx wasn't actually blank in a few places — it still had a real
claim's values baked in as if they were static text. Cross-referencing the
13 finished reports caught this:

- **Year built** was hardcoded as `1978` in the blank template. Real reports
  show it varies (1945–2022) and is sometimes omitted entirely. Added as
  `year_built`, optional.
- **Foundation type** was hardcoded as "crawlspace." Real reports show
  crawlspace, basement, and slab. Added as `foundation_type`, a 3-value enum.
- **Dwelling type** ("single family structure") was hardcoded. Real reports
  show single family, duplex, and multi family. Added as `dwelling_type`.
- **Occupancy** ("occupied by the insured") was hardcoded. Real reports show
  insured, a tenant, or tenants. Added as `occupancy_status`.
- **Square footage** ("1,280 square feet") was a specific leftover number,
  not a placeholder. Added as `square_footage`, required.
- **Roof age** only offered a 1–15 year dropdown, but real reports go up to 30. Changed from an enum to a free `roof_age_years` string so a true value
  is never rejected by an artificially narrow list.

## Design calls that need a sanity check

- **Per-slope/per-elevation fields were collapsed into one narrative field
  per section** (`roof_damage_narrative`, `exterior_damage_narrative`,
  `interior_damage_narrative`) instead of one field per "Front Slope:",
  "Right Elevation:", etc. Real reports only mention the slopes/elevations
  that actually had damage, in whatever order the adjuster wrote them — a
  rigid one-field-per-subheading model would force NEEDS INPUT markers on
  slopes nobody was ever going to mention. Brandon's dictation should read
  naturally into one field per section.
- **`roof_scope` (replace vs. repair) was dropped** as a separate field.
  The blank template implied three canned outcome paragraphs, but real
  reports write the repair/replace conclusion as part of the same sentence
  as the damage finding ("we will estimate to repair the damaged roof
  decking and shingles"). Folded into `roof_damage_narrative` instead of
  forcing it into a second field that would usually just restate the first.
- **Coverage, Mortgage stay as `variant` fields** (a fixed set of stored
  paragraphs the extractor picks between) rather than free narrative,
  because the blank template's actual legal-style wording for each outcome
  matters and shouldn't be reworded by a model. `coverage_determination`
  has a fourth option, `coverage_issue`, inferred from "due to the coverage
  issue" appearing in the Overhead & Profit, Salvage & Subrogation, and
  Claim Completion sections of the blank template — there was no coverage
  variant text for that state, so the wording there is mine, not Ibis'.
  Worth Brandon confirming the actual phrasing Ibis uses.
- **Other Structures, Personal Property, Overhead & Profit, Regulations,
  Salvage & Subrogation, Further Handling, and Claim Completion are left as
  static boilerplate**, not templatized. All 13 sample reports either match
  this boilerplate verbatim or are close enough that hand-editing the rare
  exception seemed cheaper than adding six more fields Brandon would almost
  never speak to. If that's wrong for a meaningful fraction of Brandon's
  claims, they should come back as fields.
- **Optional fields render as blank, not `[NEEDS INPUT]`** (see
  `validate.js`'s `required: false` handling). This means an empty
  `mitigation_narrative` currently leaves a bare "MITIGATION:" heading with
  nothing under it — a known cosmetic rough edge. A future pass could have
  `docgen.js` drop empty optional sections' headings entirely; not done in
  this pass since it adds structural complexity docgen doesn't need yet.
- **Roofing material after siding ("composition shingle roofing") stayed
  static** — none of the 13 samples showed variation, but that's a small
  sample. If Brandon works non-comp-shingle claims, this should become a
  field.

## How the runtime reads this data

Apps Script has no filesystem and no JSON import, so `enums.json` and
`glossary.json` can't be read directly from the repo at runtime. They're
uploaded as Drive files (in the "Adjuster MVP" folder, alongside the
flattened template doc) and `templateData.js`'s `loadEnums()` /
`loadGlossary()` fetch and parse them by file ID. This is one extra pair of
Script Properties (`ENUMS_FILE_ID`, `GLOSSARY_FILE_ID`) beyond the spec's
original "Configuration and secrets" table. The repo copies under
`apps/adjuster/template/` stay the single source of truth — re-upload the
Drive files whenever these change.

## Script Properties for the dual transcription layer

Added by spec 012 (see `docs/adr/007-dual-transcription-and-verbatim-merge.md`).
Set these in the Apps Script editor under Project Settings → Script Properties.
No key belongs in a committed file.

| Property                   | Required                  | Value                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ELEVENLABS_API_KEY`       | yes, unless mode is `off` | ElevenLabs API key, sent as the `xi-api-key` header. The only direct-vendor model call in the codebase — see ADR 007 for why it does not route through OpenRouter. Never logged.                                                                                                                 |
| `CALL_ARTIFACTS_FOLDER_ID` | recommended               | Drive folder holding one sub-folder per call (audio, the three raw transcripts, the master, `manifest.json`). Unset, everything degrades to the existing flat `RECORDINGS_FOLDER_ID` and no artifacts are written.                                                                               |
| `MASTER_TRANSCRIPT_MODEL`  | no                        | OpenRouter model for the merge call. Defaults to `OPENROUTER_MODEL`. Separate because long-context reconciliation is a different job from structured extraction and may want a different model.                                                                                                  |
| `MASTER_TRANSCRIPT_MODE`   | no                        | `off`, `shadow`, or `live`. Defaults to `shadow`. `off` is the kill switch and reproduces pre-spec-012 behavior exactly. `shadow` runs the full pass and writes every artifact but leaves the draft on the Dograh transcript. `live` extracts from the master. Reverting is a one-property flip. |

Existing properties reused unchanged: `OPENROUTER_API_KEY` (Qwen and the merge
call), `OPENROUTER_MODEL`, `OPENROUTER_FALLBACKS`, `GLOSSARY_FILE_ID` (the
keyterm list), `ADJUSTER_NAME`, `RECORDINGS_FOLDER_ID`, `DRAFTS_FOLDER_ID`.

Two operational notes:

- **Trigger interval.** The time-based trigger for `runPipelineTick` must fire at
  most every 5 minutes. The pipeline now takes two ticks per call (stage A
  transcribes, stage B extracts), so a slower interval pushes the draft outside
  the window where Brandon finds it waiting when he gets home. Confirm the
  current interval in the Apps Script UI before deploying.
- **Re-running a call.** `retranscribeJob('<capture_id>')`, run from the editor,
  clears the transcription columns and puts the job back to `pending` so stage A
  runs again — for re-reading a call after a prompt or keyterm change. It keeps
  the existing call folder and versions the new filenames alongside the old ones,
  so nothing from the previous run is destroyed.

## What's still deliberately out of scope

- Multi-building/multi-address claims (seen in one sample report, e.g.
  "507 DARE DR." / "513 DARE DRIVE" as repeated sub-sections under one
  claim). The MVP handles one dwelling per draft; Brandon can duplicate
  sections by hand for the rare multi-building claim.
- Any Xactimate line-item content. Nothing from the estimate/pricing
  portions of the sample PDFs was mined — only narrative-section vocabulary
  went into `glossary.json`, consistent with the spec's non-goals.

## Phase 1 — corrections against 11 filed reports (not just the blank template)

Phase 0 cross-checked the blank template against 13 finished reports but
largely kept the blank template's section structure. Phase 1 went back to
11 actually-filed reports section by section (see
`voice-to-report-generator/report-templates/ibis-report-pattern-analysis.md`
and `ibis-report-template-reworked.md`, both local-only per `.gitignore`)
and found several sections whose _structure_, not just field values, didn't
match real usage.

- **Coverage restructured.** Real reports write Coverage as a narrative
  cause clause + a small templated determination, not a full canned
  paragraph. Replaced `loss_cause` with `coverage_cause_narrative`
  (narrative), shrank `coverage_determination` to 2 variants (`covered` /
  `excluded`) holding just the determination sentence, and added
  `coverage_supporting_detail` (optional) for cases like a freeze claim's
  "we confirmed heat was maintained" addition. Known minor cosmetic gap:
  when `coverage_supporting_detail` is empty, the rendered sentence has a
  double space before "Therefore" (same class of rough edge as the
  optional-field blank-heading issue below) — not worth a template-engine
  change for one extra space.
- **Roof restructured into a 3-way `roof_status` variant**
  (`not_affected` / `shingle` / `other_material`), replacing the always-on
  roof sentence. 4/11 real reports skip the whole subsection with one line;
  shingle stays a full slot-filled template (`roof_covering_type` trimmed
  to shingle-only values, plus new `roof_condition` enum); non-shingle
  material (Smith's metal roof) falls back to one LLM-authored
  `roof_narrative_freeform` field, since a fixed sentence can't flex for
  arbitrary roofing material. `roof_covering_type`, `roof_condition`,
  `roof_age_years`, `roof_pitch`, and `roof_damage_narrative` are only
  required when `roof_status` is `shingle` — see `requiredWhen` below.
- **Exterior restructured the same way** — `exterior_status`
  (`not_affected` / `affected`) replaces the always-on exterior sentence;
  `exterior_narrative` (renamed from `exterior_damage_narrative`) is only
  required when affected.
- **Personal Property templatized for the first time.** Was static
  boilerplate in Phase 0. Now `personal_property_status`
  (`none` / `damaged`) — the `damaged` branch always appends a literal
  `[NEEDS INPUT: Confirm personal property list above against the
transcript before filing.]` after the narrative, even when the LLM
  extracted a clean itemized list — financial/inventory accuracy here
  warrants a forced second pass, not just a confidence-gated one.
- **Mitigation's rough edge fixed.** Phase 0 flagged optional fields
  rendering as a bare heading with nothing under it as "a known cosmetic
  rough edge." `mitigation_status` (`none` / `present`) now drops the
  `MITIGATION:` heading entirely when there's no mitigation vendor —
  matches the real pattern (4/11 reports omit it heading-and-all, never a
  bare heading).
- **Overhead & Profit, Salvage & Subrogation, and Coinsurance templatized
  for the first time** (`overhead_profit_narrative`, `subrogation_reason`,
  `coinsurance_narrative`) — Phase 0 left these fully static. Real O&P
  usage is 7 distinct wordings across 11 reports (including one case where
  O&P is affirmatively _included_), so it's a narrative field, not a small
  enum. Coinsurance appears in **zero** of 11 real reports — the blank
  template's dollar figures ($326,176.97 ITV, etc.) are almost certainly
  the same "real claim numbers baked in as static text" bug this README
  already caught for Year Built/Foundation Type/Square Footage. Kept as a
  required field (renders `[NEEDS INPUT: ...]` by default via the existing
  validation path) rather than dropped, per Brandon's call — **follow up
  with Brandon on whether Coinsurance should stay in the template at all**,
  since there's zero real precedent for it across the whole sample set.
- **Further Handling / Claim Completion: no change.** Confirmed to default
  to Claim Completion's boilerplate (already how the static text renders);
  Further Handling stays a manual edit for now, not LLM-driven.
- **`requiredWhen` added to `validate.js`.** A field can now declare
  `"requiredWhen": { "field": "<sibling tag>", "equals": "<value>" }` so
  it's only required when a sibling variant resolved to a specific branch
  — e.g. `roof_covering_type` only needs a value when `roof_status` is
  `shingle`. Without this, every not-affected or non-shingle roof claim
  would show phantom "needs input" counts for fields the rendered document
  never actually references. `docgen.js` and the tag-list prompt logic
  needed no changes — the branch that isn't chosen never has its `{{tag}}`
  inserted into the document body at all, so an unused field's resolved
  text (even `[NEEDS INPUT: ...]`) is simply never substituted.
- **Not changed in this pass, deliberately:** Other Structures stays fully
  static boilerplate (no decision made on templatizing it yet); Risk
  Information's "composition shingle roofing" tail still hardcodes shingle
  even though Roof itself now handles non-shingle material — same
  Phase 0-flagged risk, just not resolved here.

## Phase 1b — prompt.js guidance + a template correction it exposed

Writing the actual extraction-prompt content for Phase 1's new/changed
fields surfaced one thing that couldn't be fixed in the prompt alone:
`present_at_inspection` fed into a sentence with `" was present during the
inspection."` hardcoded as static template text, so no prompt instruction
could make the verb agree with a multi-person `present_at_inspection`
value — the word "was" never went through the LLM at all. Added
`present_at_inspection_verb` (enum: `was` / `were`) as its own tag, with
the template line now reading `{{present_at_inspection}}
{{present_at_inspection_verb}} present during the inspection.` — this is a
schema/template change, not prompt content, even though the underlying
decision ("was" vs. "were" should be grammatically correct, not copy the
adjuster's habit of always saying "was") is a prompt-phase call.

Everything else deferred at the end of Phase 1 is now in `prompt.js`:
enum-preference + extra-detail-to-`unplaced_notes` guidance and ad hoc
section examples (Tree Removal, Business Personal Property, Additional
Living Expense, Loss of Use, prior/previous claims) live in the general
`system` instructions; per-field guidance (roof slope/elevation
completeness, the `roof_narrative_freeform` few-shot example for
non-shingle roofs, interior level-grouping, Personal Property's three-way
listed/deferred/unextracted logic, Overhead & Profit's determination+reason
shape and coverage-issue cross-reference, the Salvage & Subrogation escape
hatch for one-off arguments like Galicia's warranty-based rewrite, and
Coinsurance's "almost never applies" instruction) lives in `prompt.js`'s
`FIELD_GUIDANCE` map, gated so a tag's guidance only appears in the prompt
when that tag is actually present in the schema passed in.

## Phase 1c — correction: `[DATE_RECEIVED]`/`[DATE_CONTACTED]`/`[DATE_INSPECTED]`/`[DATE_LOSS]` are not ours to fill

The very first instruction behind this whole rework was that the blank
template's square-bracket tokens (`[DATE_RECEIVED]`, `[DATE_CONTACTED]`,
`[DATE_INSPECTED]`, `[DATE_LOSS]`) are Ibis's own merge-field markup —
exact-match variables that stay in the final template as-is, not narrative
content the voice-to-report pipeline extracts or fills. Phase 1 recorded
that decision in the analysis docs but never actually applied it to
`enums.json`/`template.flattened.txt` — `date_received`, `date_contacted`,
`date_inspected`, and `date_of_loss` were left as ordinary `{{}}`
LLM-extracted fields, carried over unchanged from Phase 0. Fixed now:

- Removed `date_received`, `date_contacted`, `date_inspected`, and
  `date_of_loss` from `enums.json` entirely — nothing else in the codebase
  referenced them (checked before removing).
- `template.flattened.txt` now has the literal tokens `[DATE_RECEIVED]`,
  `[DATE_CONTACTED]`, `[DATE_INSPECTED]`, `[DATE_LOSS]` in place of the old
  `{{date_received}}` etc. tags. These are inert to `docgen.js`'s
  `{{tag}}`-only replacement regex and to `findLeftoverTags`'s
  `{{\w+}}`-only leftover check, so they pass straight through untouched —
  exactly the intended behavior.
- Added a regression test (`template.test.ts`, "Ibis merge-field tokens
  (not ours to fill)") asserting the four tokens stay literal text in the
  template and that none of the four ever reappears as a schema field.

`contacted_party_name` and `present_at_inspection`/
`present_at_inspection_verb` are unaffected — the blank template only used
blank underscores (`_____`) for those, not square brackets, so they were
always genuinely ours to extract from the voice note.

## Phase 1d — system prompt reworked around the strict-schema reality

The system prompt told the model to "omit that field entirely rather than
inventing" a value — but `openrouter.js` requests `strict: true` structured
output with every tag in `required`, so omission is impossible and a model
with no evidence was being forced to invent. Rewritten around the
empty-value convention (`value: ""`, `source_span: ""`), which
`validate.js` already turns into `[NEEDS INPUT]` markers. The rewrite also
adds: voice-transcription error expectations, verbatim-span rules (copy
transcription errors, never splice), value-normalization limits, concrete
high/low confidence criteria (torn → low), an affirmative-statement rule
for status variants (silence is not "not_affected"), dates/claim
numbers/carrier routed to `unplaced_notes`, and claim context as
disambiguation only — with a mismatch note when the transcript names a
different insured/address.

Two schema gaps the prompt could not fix: `mortgage_company` and
`mitigation_narrative` were optional, so a chosen `has_mortgage`/`present`
branch with a missing value rendered silent blank text ("mortgage is
through .") instead of flagging. Both are now
`requiredWhen` their status branch is selected.

## Phase 2 — guided (section-by-section) call flow, exploratory, not live

**Superseded (spec-019).** This flow was Telnyx-only and never went live;
Telnyx is retired — see [ADR 008](../../../docs/adr/008-telnyx-retired.md).
`guidedFlow.js`, `docs/telnyx-texml-interactive-ivr.md`,
`template/interactive-call-script.txt`, and
`apps/bh-systems/public/texml/guided-intake.xml` referenced below are all
deleted. Left in place as history.

An alternative to the single continuous-narration call in
`field-notes.xml`/`webhook.js`: the adjuster gets asked one short
question per Ibis section instead of one open-ended "record your
message" prompt. Design notes and the field→verb mapping are in
`docs/telnyx-texml-interactive-ivr.md` and
`template/interactive-call-script.txt`; the implementation is
`src/guidedFlow.js` (dispatched from `webhook.js`) plus
`apps/bh-systems/public/texml/guided-intake.xml` as the static entry
point. Covered by `tests/unit/adjuster/guidedFlow.test.ts`.

Not wired to any live Telnyx number — nothing changes for the existing
flow, and swapping between the two is just pointing a Telnyx number's
Voice URL at one static XML file or the other. Both write the same
`transcript`/`status` shape to the Jobs sheet, so `matcher.js`,
`prompt.js`, and `runner.js` need zero changes to consume a
guided-flow job either way.

Before this goes live:

- **The Jobs sheet needs a new `guided_state` column** (a JSON blob
  holding in-progress section state). `upsertJob()` throws on a
  missing column, so this has to exist before a real call reaches it
  — same category of prerequisite as `templateData.js`'s
  `ENUMS_FILE_ID`/`GLOSSARY_FILE_ID` Script Properties above.
- **The AIGather result parameter name is unconfirmed against a live
  call.** Telnyx's docs describe "base64-encoded JSON" in the `action`
  callback payload but not the field name it arrives under.
  `parseAIGatherResult()` in `guidedFlow.js` checks several candidate
  names as a hedge — replace with the confirmed name after one real
  test call, the same confirm-against-a-live-call step `webhook.js`'s
  own top-of-file comment documents having already done for
  `CallSessionId`.
- **A stuck `awaiting_section_transcripts` job has no promotion
  sweep.** If a Record section's `transcriptionCallback` never lands,
  that job sits forever — unlike the single-shot flow, which
  `jobs.js`'s `promoteStaleAwaitingTranscript()` already recovers from
  the equivalent stuck state after 15 minutes. Flagged in a comment
  above `allSectionTranscriptsIn()` in `guidedFlow.js`.
- **Gather/AIGather-resolved fields still pass back through
  `prompt.js`'s LLM extraction**, via the stitched transcript, instead
  of being merged into the final draft directly. That's deliberate for
  now — it keeps the guided flow's output 100% pipeline-compatible
  with zero changes to `runner.js`/`prompt.js` — but it means a field
  already resolved exactly by a closed `Gather`/`AIGather` enum (e.g.
  `coverage_determination`) is re-derived by the LLM from text like
  `coverage_determination: covered` instead of being trusted outright.
  Worth revisiting once this is closer to live.

## Phase 3 — single-stage AIGather, a third call flow, exploratory, not live

**Superseded (spec-019).** This flow was also Telnyx-only and never went
live — see [ADR 008](../../../docs/adr/008-telnyx-retired.md).
`apps/adjuster/docs/guided-flow-debugging-handoff.md`,
`apps/bh-systems/public/texml/single-stage-aigather.xml`,
`handleSingleAIGatherEnded()`, and
`tests/unit/adjuster/singleStageAIGather.test.ts` referenced below are all
deleted. Left in place as history.

`apps/adjuster/docs/guided-flow-debugging-handoff.md` root-caused why
`<AIGather>` can't be one section in Phase 2's chain: it's a Call
Control REST command under the hood, its result arrives via a
`call.ai_gather.ended` webhook event, not the verb's own `action`
callback, and returning TeXML from that handler does not continue the
call — confirmed on live calls, it hangs up regardless. That's fatal
for a multi-section chain but irrelevant to a call with only one
section: nothing needs to continue after the single `<AIGather>` turn
finishes, since the call ending there is the desired behavior, not a
failure to route around.

`apps/bh-systems/public/texml/single-stage-aigather.xml` is that:
one `<AIGather>` verb, one schema covering every Ibis template field
in one flat object (no chaining, no `guided_state`), with a `Greeting`
that asks for identity + carrier up front, invites the adjuster to
narrate the whole report, and explicitly tells them they can end the
call once they've said everything they know even if some fields go
unanswered. Unlike Phase 2's per-section schemas, none of this
schema's fields use `enum` — see the file's own header comment for
why (short version: it wouldn't be enforced even if used, since
Telnyx never delivers this schema's structured JSON back to us, only
the raw conversation). `apps/adjuster/src/webhook.js`'s
`handleSingleAIGatherEnded()` stitches that conversation into the
same `transcript` shape every other flow already produces, so
`matcher.js`/`prompt.js`/`runner.js` need zero changes. Covered by
`tests/unit/adjuster/singleStageAIGather.test.ts`, including a
regression test that a `call.ai_gather.ended` event for a genuinely
in-progress guided-flow call session still routes to
`handleGuidedAIGatherEnded()`, not this handler — the two flows share
the same shape-detected event with no way to key off an `event`
param, so `webhook.js`'s `isGuidedFlowCall()` routes between them by
checking whether the call session already has a `guided_state` with
`flow: 'guided'`.

Live-tested against a real Telnyx number as of 2026-08-20. First two
test calls lost their transcript entirely — the fix above
(`isGuidedFlowCall()`) had only been pushed to this repo, not to the
live Apps Script deployment (`clasp push` alone doesn't update what's
live at the `/exec` URL; it needs `clasp deploy -i <the pinned
deployment ID>` too, a trap this project's own debugging handoff doc
already called out). Once actually deployed, this should route
correctly — not yet re-confirmed against a live call at time of
writing.

Recording was added the same day via a per-Telnyx-number "record the
whole call" toggle (Telnyx dashboard, outside this repo) rather than
any TeXML change — `<AIGather>` has no `record` attribute and no
TeXML-level way to record concurrently with it (checked against
Telnyx's docs). The recording surfaces via a `CallStatus: "analyzed"`
webhook event, shape-detected the same way as `call.ai_gather.ended`
(no `event` param of our own) by `webhook.js`'s
`looksLikeCallAnalyzed()`/`handleCallAnalyzed()`. Two things about
this are still open, not resolved:

- **The `Recordings` field's shape isn't documented anywhere in
  Telnyx's public TeXML reference.** `firstRecordingUrl()` handles a
  bare URL string or an object with a `url`/`recording_url`/
  `download_url` key as a hedge, and `handleCallAnalyzed()` logs the
  full raw payload via `logServerOnly()` on every call so the real
  shape can be confirmed and the hedge tightened — same
  confirm-against-a-live-call pattern as `CallSessionId`'s field name
  and `guidedFlow.js`'s `parseAIGatherResult()`.
- **Timing:** in the one real call observed, this event arrived ~14
  minutes after `call.ai_gather.ended` — likely after `runner.js` has
  already extracted fields and generated the doc from the AIGather
  conversation alone. `handleCallAnalyzed()` still appends a
  `[CALL RECORDING]` section to the job's `transcript` (merged with
  the `[AIGATHER CONVERSATION]` section `handleSingleAIGatherEnded()`
  writes, via the new `appendTranscriptSection()` helper — order-
  independent, whichever event lands first) and sets `recording_url`,
  so both sources of truth for what was said feed into the extraction
  prompt together whenever they're both in before extraction happens.
  But it does **not** re-trigger extraction or regenerate an
  already-generated doc for a job the runner already finished before
  the recording arrived. Whether a late recording should force
  re-extraction is a real design decision, not made here — depends on
  how consistently delayed this event turns out to be in practice.

## Phase 4 — XM8 merge tokens for mortgagee and insured name

Following the same "not ours to fill" pattern established in Phase 1c
for the date fields, Ibis's XM8/Xactimate integration now supplies two
more merge fields directly: `[XM8_MORTGAGEE1]` (the lender name) and
`[XM8_INSURED_NAME]` (the insured's legal name). Both are literal
square-bracket tokens left untouched by `docgen.js`'s `{{tag}}`-only
replacement, exactly like `[DATE_LOSS]`.

- `mortgage_status`'s `has_mortgage` text changed from `"...their
mortgage is through {{mortgage_company}}."` to `"I confirmed with
[XM8_INSURED_NAME] that their mortgage is through
[XM8_MORTGAGEE1]."`; `no_mortgage` changed to the literal `"There is
not a mortgage on the property."` (dropped the "I confirmed with the
  insured that" lead-in per the call script's exact wording).
- `mortgage_company` is removed from `enums.json` and `prompt.js`'s
  `FIELD_GUIDANCE` entirely — the call no longer asks who the lender
  is, only whether one exists, since XM8 supplies the name.
- ORIGIN's two lines (`{{origin_narrative}}` + a separate `Date of
loss: [DATE_LOSS].` line) collapsed into one sentence: `"Damage
occurred due to {{origin_narrative}} on [DATE_LOSS], resulting in
damage to {{origin_damage_narrative}}."` `[DATE_LOSS]` stays a
  literal, untouched token per Phase 1c. `origin_damage_narrative` is
  a new field (what was actually damaged) split out from
  `origin_narrative` (the cause only) — one free-narration call-script
  answer still yields both, the same way COVERAGE splits one answer
  into cause/determination/detail.
- The call script (`dograh-script.md`, `interactive-call-script.txt`)
  no longer asks for year built, square footage, bedroom count, or
  bathroom count — those are meant to come from matched calendar/claim
  data instead. `year_built` is also dropped from `dograh-script.md`'s
  bottom "Variables to Track" block, same as the other three.
  **That mapping does not exist yet anywhere in this codebase** (the
  only non-transcript context actually wired in is `prompt.js`'s
  `formatClaimBlock()`, sourced from the Claims Google Sheet, which
  carries none of these four fields today). Until that's built, these
  four fields will render as `[NEEDS INPUT]` on every report
  (`year_built` is `required: false` in `enums.json`, so it just
  renders blank instead).
- The roof section now asks an explicit "Is the roof composition
  shingle roofing?" yes/no gate before branching to the shingle
  dropdown-paragraph flow or a freeform "Please provide more details"
  follow-up, and both call scripts + `prompt.js`'s guidance call out
  that a shingle's warranty rating (e.g. "20 year", "30 year
  laminate") is a product class, not the roof's actual age — age is
  always asked for explicitly and separately.

Not yet touched at the time: `guidedFlow.js` (Phase 2) and
`apps/bh-systems/public/texml/single-stage-aigather.xml` (Phase 3), both
exploratory/non-Dograh call flows out of scope for this pass. Both are now
deleted (spec-019) rather than updated.

## Phase 5 — per-component status fields replace the variant-nested findings lines

Brandon edited the live Ibis template Google Doc directly — not the repo's
`.docx`/`template.flattened.txt` copies — adding nine new placeholders under
Roof and Exterior: `{{soft_metal_status}}`, `{{front_slope_status}}`,
`{{right_slope_status}}`, `{{back_slope_status}}`, `{{left_slope_status}}`
under Roof, and `{{front_elevation_status}}`, `{{right_elevation_status}}`,
`{{back_elevation_status}}`, `{{left_elevation_status}}` under Exterior. Doc
read 2026-08-27
(`https://docs.google.com/document/d/1w_snnqh1iYxftHvD4zG15Sn6OecJ0uNBZQtWDPZT3Eg`):
each is its own labeled line in the document body, always present — not
nested inside `roof_status`/`exterior_status`'s variant text the way Phase 1
built them.

**This is a structural reversal of Phase 1's roof/exterior design, not an
additive change.** Phase 1 collapsed per-slope/per-elevation findings into
lines embedded conditionally inside the `shingle`/`affected` variant
branches' own `text` (`roof_soft_metals`, `roof_front_slope`,
`roof_right_slope`, `roof_back_slope`, `roof_left_slope`;
`exterior_front_elevation`, `exterior_right_elevation`,
`exterior_back_elevation`, `exterior_left_elevation` — enums.json:229–307),
so those lines only ever appeared in the rendered doc when `roof_status ==
shingle` / `exterior_status == affected`. The new doc instead prints all
nine lines unconditionally, as top-level template placeholders analogous to
`interior_damage_narrative`.

**Urgent — this may already be breaking production.** `docgen.js`'s
`findLeftoverTags()` check (docgen.js:29) fails the draft (`status:
'failed'`) if any `{{tag}}` in the copied doc goes unreplaced. If the linked
Google Doc is genuinely the one the `TEMPLATE_DOC_ID` Script Property points
to — unconfirmed; Barton said "I believe" but this hasn't been checked
against the live Apps Script Script Properties — every report generated
since Brandon's edit will fail doc generation with `Unreplaced tags:
soft_metal_status, front_slope_status, ...`, since none of these nine tags
exist yet in `enums.json`/`prompt.js`. **First action item, before anything
else below: confirm `TEMPLATE_DOC_ID` in the Apps Script editor against file
ID `1w_snnqh1iYxftHvD4zG15Sn6OecJ0uNBZQtWDPZT3Eg`.**

### Design calls that need a sanity check (ask Brandon before implementing)

- **Renaming vs. duplicating.** This spec treats the nine new placeholders
  as a rename+promotion of the nine Phase 1 fields (`roof_soft_metals` →
  `soft_metal_status`, `roof_front_slope` → `front_slope_status`, etc.), not
  new fields added alongside the old ones — the new doc's placeholders sit
  in the exact same "Label: findings" position the old variant-nested lines
  held, just promoted to the top level. If Brandon actually wants both the
  old per-slope narrative (nested, conditional) and a new, separate status
  concept, that's a larger change than this pass covers.
- **Field type — still free narrative, or a real status enum?** The
  `_status` suffix could signal these should become a closed enum (e.g.
  `no_damage` / `damage_noted` / `not_inspected`) with a separate narrative
  field elsewhere, rather than the free-text findings prose Phase 1 used.
  This spec keeps `type: "narrative"` — same content depth Brandon already
  dictates ("front slope: minor granule loss, no exposed decking") — since
  the doc's `Label: {{tag}}` rendering shape is identical to before and
  nothing in the doc suggests a second field per component. Confirm this
  reading with Brandon before implementing.
- **Should these render when the section is `not_affected`?** Because these
  nine lines are now unconditional body text, a `not_affected` roof or
  exterior will still print `Soft Metals:`, `Front Slope:`, etc. with
  nothing after the colon when left blank — the same "bare heading, no
  content" cosmetic gap Phase 0 flagged for optional fields at section
  scale, just recurring at line-item scale here. Recommend accepting it for
  this pass (matches Phase 0's precedent) rather than teaching `docgen.js`
  to drop blank `Label: ` lines, unless Brandon says the blank lines read as
  unprofessional in practice.
- **The `shingle`/`affected` variant text must drop its nested per-component
  lines** now that those lines are promoted to top-level tags, or the
  rendered doc will show each slope/elevation finding twice.

### Concrete changes once the above is confirmed

**`enums.json`** — rename and promote out of `roof_status.values[1].text`
(the `shingle` branch, line 168): `roof_soft_metals` → `soft_metal_status`,
`roof_front_slope` → `front_slope_status`, `roof_right_slope` →
`right_slope_status`, `roof_back_slope` → `back_slope_status`,
`roof_left_slope` → `left_slope_status`. Rename and promote out of
`exterior_status.values[1].text` (the `affected` branch, line 280):
`exterior_front_elevation` → `front_elevation_status`,
`exterior_right_elevation` → `right_elevation_status`,
`exterior_back_elevation` → `back_elevation_status`,
`exterior_left_elevation` → `left_elevation_status`. Keep `type:
"narrative"`, `required: false`, correct `section` on all nine — unchanged
from Phase 1. Trim `roof_status.values[1].text` down to just the covering/
age/condition/pitch sentence (drop the `"My inspection of the roof found
the following:\nSoft metals: ..."` tail) and trim `exterior_status.values[1]
.text` similarly — those lines move to the template body. `roof_narrative_
freeform` (non-shingle roofs) is unaffected; the four slope lines still
print underneath it, blank, since a non-shingle roof was never asked
per-slope.

**`template.flattened.txt`** — replace lines 18–19 (Roof) and 21–22
(Exterior) to mirror the linked Google Doc exactly:

```
Roof
{{roof_status}}

Soft Metals: {{soft_metal_status}}
Front Slope: {{front_slope_status}}
Right Slope: {{right_slope_status}}
Back Slope: {{back_slope_status}}
Left Slope: {{left_slope_status}}

Exterior
{{exterior_status}}

Front Elevation: {{front_elevation_status}}
Right Elevation: {{right_elevation_status}}
Back Elevation: {{back_elevation_status}}
Left Elevation: {{left_elevation_status}}
```

Re-diff against the live doc immediately before implementing, in case
Brandon edits it further in the meantime.

**`prompt.js`** — no change needed to `formatTagList()`, which derives the
tag list from `templateSpec` (i.e. `enums.json`) automatically. Add nine
renamed `FIELD_GUIDANCE` entries (currently lines 119–133), carrying the
existing guidance text over verbatim under the new keys so the "don't
invent a no-damage finding for a component nobody mentioned" and
"fold in a compound slope label" rules survive the rename: `soft_metal_
status` (from `roof_soft_metals`), `front_slope_status`/`right_slope_
status`/`back_slope_status`/`left_slope_status` (from `roof_front_slope`
etc.), `front_elevation_status`/`right_elevation_status`/`back_elevation_
status`/`left_elevation_status` (from `exterior_front_elevation` etc.).

**`templateData.js`** — add a new dated migration function (e.g.
`syncEnumsFileFromRepo_20260827()`) pushing the updated `enums.json` to the
live Drive file (`ENUMS_FILE_ID`), following `syncEnumsFileFromRepo_
20260822()` (line 16) exactly — run once from the Apps Script editor, then
delete per that function's own stated lifecycle.

**`validate.js` / `docgen.js`** — expected to need no code changes; both
are schema-driven off `enums.json` with no hardcoded field names (verify
this holds during implementation).

**`tests/unit/adjuster/template.test.ts`** — the `{{tag}}` ⟷ `enums.json`
parity checks should pass automatically once both files are updated
consistently; update any test that snapshots specific rendered text for the
`shingle`/`affected` variant branches to match the trimmed variant text.

**`tests/unit/adjuster/prompt.test.ts`** — line 151 (`FIELD_GUIDANCE`
fixture using `roof_front_slope`) and line 158 (`expect(user).toContain
('roof_front_slope:')`) reference the old field name directly and need
updating to `front_slope_status`.

**Out of scope, same as Phase 1's precedent** — `guidedFlow.js`,
`dograh-workflow-live.md`, `dograh-script.md`, and `interactive-call-
script.txt` still reference pre-Phase-1 field names (`roof_damage_
narrative`, `exterior_narrative`) and aren't touched here, same
"exploratory/non-live, out of scope for this pass" call made for Phase 1
and Phase 4. Separately worth asking Brandon: does the live call script
(Dograh, per Phase 4) already get him narrating slope-by-slope and
elevation-by-elevation, or does it currently ask one open "roof findings"
question? If the latter, the call script itself may need restructuring so
these nine fields actually get populated from a real call, not just
renamed in the schema. Not resolved here.

### Before this goes live

- [x] `TEMPLATE_DOC_ID` confirmed against `1w_snnqh1iYxftHvD4zG15Sn6OecJ0uNBZQtWDPZT3Eg` — confirmed same doc
- [x] Brandon confirms: rename-in-place vs. genuinely new status field — confirmed freeform narrative rename, no closed enum
- [x] Brandon confirms: whether the live call script already elicits per-component answers — it doesn't; the inspector free-narrates by compass direction (e.g. "the north side") and extraction has to map that to front/right/back/left, so `prompt.js`'s `FIELD_GUIDANCE` was written with explicit compass-direction mapping instructions rather than assuming the call script asks per-side
- [x] `enums.json` and `template.flattened.txt` re-diffed against the live doc immediately before upload
- [x] `syncEnumsFileFromRepo_20260827()` run once from the Apps Script editor, then deleted
- [x] `tests/unit/adjuster/template.test.ts` and `tests/unit/adjuster/prompt.test.ts` passing with the renamed fields
- [x] `clasp push` + `clasp deploy` run against the live deployment
- [ ] One real (or synthetic) end-to-end draft generated against the live doc with no leftover-tag failure

## Phase 6 — remove the was/were gate, loosen dwelling_stories, stop silently-blank required info, and a real coinsurance "no" answer

Six behavior fixes to `enums.json`/`prompt.js`/`docgen.js`/`template.flattened.txt`, all in the direction of "flag it instead of silently rendering blank or forcing a bad enum fit":

- **`present_at_inspection_verb` removed.** It existed only to conjugate "was"/"were" for a hardcoded template sentence (Phase 1b). `present_at_inspection` is now `type: "narrative"` and the model writes the whole sentence itself ("Jane Smith was present during the inspection." / "Jane Smith and John Doe were present during the inspection."), so the verb never needs its own gated field with a derived source_span. `template.flattened.txt`'s Assignment line is now just `{{present_at_inspection}}` — no trailing static "present during the inspection." text.
- **`dwelling_stories` is no longer a closed enum.** `["1 story", "2 story", "3 story", "4 story"]` forced a `[NEEDS INPUT]` miss on anything outside that exact list (e.g. "a story and a half", "split level") even though the adjuster gave a perfectly good answer. Changed to `type: "string"`, `required: true` (still flags when genuinely unsaid), with `FIELD_GUIDANCE` suggesting "1 story, 2 story, 3 story" as the common cases but telling the model to use whatever the adjuster actually said.
- **`year_built` is now `required: true`.** It was `required: false`, so an unstated year rendered as a silent blank ("It was built in on a crawlspace foundation.") with no `[NEEDS INPUT]` flag at all — the exact "optional fields render as blank, not NEEDS INPUT" cosmetic gap Phase 0 first flagged. Still in `CALENDAR_FALLBACK_TAGS`, so the calendar invite still fills it unflagged when the transcript doesn't state it; only a claim with neither source now flags.
- **All nine roof/exterior status fields are now `required: true`** — the four per-slope, four per-elevation fields, plus `soft_metal_status` (initially left `required: false` since it isn't a per-side field, then flipped to match the others on request). Same silent-blank problem as `year_built`, at line-item scale: `front_slope_status`/`soft_metal_status`/etc. always render as their own labeled line (`Front Slope: `, `Soft Metals: `) regardless of `roof_status`/`exterior_status`, so a component nobody discussed used to render a blank line with no flag. Now it flags per component, so a full roof/exterior confirmation is visibly required rather than silently assumed. `FIELD_GUIDANCE` updated to drop the now-false "renders blank either way" claim.
- **Medium-confidence highlighting now isolates the "heard" citation, not the whole sentence.** `docgen.js`'s `markForReview` used to wrap the real value _and_ its trailing `[heard: "..."]` citation in one highlighted block, so the sentence Brandon actually wants to keep in the report was itself painted yellow. It now highlights only the `[heard: "..."]` citation (falling back to highlighting the whole value when there's no citation to isolate, e.g. a variant's canned text) — the real sentence stays plain, and only the citation Brandon shouldn't leave in the filed report gets flagged.
- **Coinsurance: "no coinsurance" is now a canned line, not a forced miss.** `coinsurance_narrative` was `required: true` with no conditional, so the ordinary "no coinsurance applies" answer — true on nearly every claim, per Phase 1's finding that zero of 11 real reports even mention coinsurance — rendered as a generic `[NEEDS INPUT: Coinsurance...]` every time. Added `coinsurance_status` (`variant`, mirrors `mitigation_status`'s shape): `no_coinsurance` renders a canned "There is no coinsurance penalty applicable to this loss." line; `applies` renders `{{coinsurance_narrative}}`, which is now `requiredWhen coinsurance_status == "applies"`. `template.flattened.txt`'s COINSURANCE section now reads `{{coinsurance_status}}`. Added "coinsurance" to the system prompt's affirmative-statement list (silence ≠ "no coinsurance", same as roof/exterior/mortgage/mitigation) so an unaddressed coinsurance question still flags rather than defaulting to the canned line.

`dograh-script.md`/`dograh-workflow-live.md` updated for the same six changes (removed the verb row, loosened the stories example, updated the coinsurance row/status/canned-line description) — same "keep the live-call docs in sync for behavior changes, not just field renames" treatment as Phase 5, even though those docs still carry the pre-Phase-1 `roof_damage_narrative`/`exterior_narrative` naming drift noted there. `guidedFlow.js`/`interactive-call-script.txt` (Phase 2/3, not live) untouched, same precedent.

### Before this goes live

- [x] `enums.json`, `template.flattened.txt`, `prompt.js`, `docgen.js`, `calendarSync.js` updated and internally consistent
- [x] `syncEnumsFileFromRepo_20260827b()` added to `templateData.js`, JSON payload verified byte-for-byte against `template/enums.json`
- [ ] `syncEnumsFileFromRepo_20260827b()` run once from the Apps Script editor, then deleted
- [ ] Live Google Doc (`1w_snnqh1iYxftHvD4zG15Sn6OecJ0uNBZQtWDPZT3Eg`) edited to match `template.flattened.txt`: Assignment line drops `{{present_at_inspection_verb}}`, COINSURANCE section's `{{coinsurance_narrative}}` becomes `{{coinsurance_status}}`
- [ ] `tests/unit/adjuster` passing
- [ ] `clasp push` + `clasp deploy` run against the live deployment
- [ ] One real (or synthetic) end-to-end draft generated confirming: a mixed-slope roof call shows per-side NEEDS INPUT only for the sides not discussed, an explicit "no coinsurance" answer renders the canned line (not NEEDS INPUT), and a medium-confidence narrative's sentence itself is not painted yellow
