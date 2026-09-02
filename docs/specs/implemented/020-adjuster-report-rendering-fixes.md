# Adjuster report rendering fixes — highlights, blanks, clauses, and open vocabularies

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-09-01

## Objective

Six defects found by reading generated drafts against the live pipeline
(`ENUMS_FILE_ID` confirmed synced to `template/enums.json` as of 2026-09-01, so
these are all live-code problems, not stale-deploy artifacts). Every one of them
is a rendering or extraction-shaping issue in the Apps Script report generator:
a "heard" citation that never gets highlighted, sections that render as an
invisible blank, a mid-sentence clause that reads as a broken sentence, a
coverage paragraph that says the same thing three times, and seven closed enums
that reject a perfectly good answer the adjuster actually gave. The through-line
is the same principle already stated in `docgen.js`: never silently render
something wrong or invisible — flag it, or render a real sentence.

## Non-goals

- No change to the call side. Dograh/Retell workflows, the call script, and the
  transcription layer are untouched.
- No change to the extraction JSON schema (`buildExtractionSchema` in
  `llm/openrouter.js`) — it already types every value as a plain string, so the
  enum work needs nothing from it.
- Variants stay closed sets. A variant key selects a canned paragraph, so a
  free-text key has nothing to render. Only `type: "enum"` fields open up.
- No fix for the hardcoded `composition shingle roofing` in the Risk Information
  sentence (it prints on metal roofs too). Noted below, deliberately deferred.
- No new spec-level review UI. Off-vocabulary values are logged for periodic
  human review, not surfaced in the draft.
- `scripts/adjuster-inject-test-job.mjs` is **not used** to verify this spec. See
  "Verification without vendor spend" below.

## Business Rationale

Every one of these lands in a document Brandon files with a carrier. A blank
mitigation section, a coverage paragraph that repeats itself, and an
un-highlighted machine-transcribed quotation are all things he has to catch by
hand on every draft — which is the exact review cost the pipeline exists to
remove. The enum loosening is the same argument in reverse: seven fields
currently discard a correct spoken answer because it was not on a list, and each
discard becomes a `[NEEDS INPUT]` he fills in manually.

## Architecture

All changes are inside `apps/adjuster` — Apps Script plus its Drive-hosted
schema. **No database migrations, no Edge Functions, no frontend, no shared
package impact, no auth-model change, no new env vars.** Nothing here touches
Supabase.

Two artifacts live outside the repo and are updated by hand, as they always have
been:

1. **`ENUMS_FILE_ID`** — the runtime schema. `template/enums.json` is the repo
   source of truth; it reaches Drive only via a one-shot
   `syncEnumsFileFromRepo_*()` in `templateData.js` that is run once from the
   Apps Script editor and then deleted. `tests/unit/adjuster/templateData.test.ts`
   asserts exactly one such function exists and that it emits `enums.json`
   byte-for-byte, so the repo edit and the sync payload cannot drift.
2. **`TEMPLATE_DOC_ID`** (`1w_snnqh1iYxftHvD4zG15Sn6OecJ0uNBZQtWDPZT3Eg`) — the
   Google Doc the draft is copied from. `template/template.flattened.txt` is the
   repo's mirror of it and is not read at runtime; the live Doc must be edited by
   hand to match. Only Phase 6 requires a Doc edit.

### Decision: plain-text markers, not sentinel characters

The medium-confidence highlight is currently keyed on `\x02`/`\x03` sentinels
wrapped around the citation, searched for with `body.findText('\x02[^\x03]*\x03')`.
Google Docs sanitizes ASCII control characters out of body text on insert, so the
markers do not survive `replaceText` and the search matches nothing. The fix is
to stop depending on a character surviving a round-trip at all: every reviewable
insertion becomes a visible `[...]` bracket, found and highlighted by the same
mechanism `[NEEDS INPUT: ...]` already uses successfully.

### Decision: `suggestions`, not `enum`

`type: "enum"` with a closed `values` list becomes `type: "string"` with a
`suggestions` list. Enforcement lived in exactly two places — the prompt (which
told the model the list was closed) and `validate.js` (which rejected anything
off-list). Both become advisory. A value that lands off-list is valid, rendered,
and **logged** as `extraction.off_suggestion` so the lists can be grown from real
calls rather than guessed at up front.

This changes one behavior deliberately: `validateLiveFields` currently trusts a
Dograh/Retell value only when the field is an enum or variant, because closed-set
membership is the only check available for a value with no transcript span. These
seven fields keep that trust after becoming `suggestions` fields — same closed-form
low-risk property facts the calendar fallback already trusts unvalidated. Free-text
fields with no `suggestions` list continue to route to manual review.

### Decision: clause fields are normalized, not just instructed

`origin_narrative`, `origin_damage_narrative`, `coverage_cause_narrative`, and
`subrogation_reason` are all mid-sentence clauses dropped into a fixed template
sentence. That contract is prompt-only today and nothing checks it, so a
full-sentence answer prints as `Damage occurred due to A severe storm damaged the
roof. on [DATE_LOSS], resulting in damage to ...`. They gain an explicit
`"form": "clause"` in the schema and a normalizer at render time. Where
normalization cannot produce a clause, the field flags rather than printing a
broken sentence — a mangled cause-of-loss sentence in a filed insurance report is
worse than a yellow marker.

### Decision: verification replays saved artifacts instead of re-running the pipeline

Five of the six fixes are pure rendering, downstream of every vendor call. The
sixth (prompt wording, Phase 5) needs one model call, not a full pipeline run.
Phase 0 adds the harness that makes that separation usable, so verification of
this spec costs approximately nothing. See "Verification without vendor spend".

### ADR

No ADR. `docs/adr/006-adjuster-apps-script-runtime.md` already covers the runtime
decision; these are behavior fixes inside it, which the CLAUDE.md guidance
explicitly exempts.

## Implementation Phases

Phases 1–5 are independently deployable via `clasp push` + `clasp deploy`.
Phase 6 additionally requires the live Doc edit and must ship together with its
`enums.json` change. Phases 2, 4, 5, and 6 all touch `enums.json`, so a single
new `syncEnumsFileFromRepo_20260902()` carries whichever of them ship together;
the parity test enforces that it matches.

### Phase 0 — Replay harness (zero vendor calls)

Ships first, on its own. Everything after it is verified through it.

**`src/runner.js`** — persist the extraction result as a call-folder artifact:

```js
writeCallArtifact(
  folder,
  'extraction.json',
  JSON.stringify({
    capture_id,
    model,
    transcript_source: input.source,
    fields: extraction.fields,
    unplaced_notes: extraction.unplaced_notes,
  }),
)
```

Today the extraction output exists only as a `logServerOnly` line in Cloud
Logging, which ages out — so every paid run throws away the one artifact that
would let the rendering side be replayed for free. Transcripts are already
persisted this way (`transcript-master.txt`, `transcript-elevenlabs.txt`, ...);
the extraction JSON is the missing sibling.

**`src/replay.js`** (new; plain functions run by hand from the Apps Script
editor):

- `regenerateDraftFromArtifacts(captureId)` — reads the saved extraction and,
  through the existing `resolveExtractionTranscript`, the saved transcript, then
  runs the same validate-and-render path a live job runs. **No ASR, no merge, no
  extraction. Zero vendor calls.** Writes a real Google Doc to the drafts folder,
  which is the only way to actually see highlighting, spacing, and blank sections
  in the real renderer.
- `reExtractFromArtifacts(captureId)` — re-runs extraction against the saved
  transcript, then renders. **One OpenRouter call**, skipping both ASR calls and
  the long-context merge. This is the Phase 5 check, and the only paid step in
  the whole spec.

**`src/runner.js`** — the validate-and-render sequence moves into
`renderDraftFromExtraction`, shared by the live pipeline and both replay entry
points. A replay that reproduced the sequence separately could drift from
production and would then verify nothing.

**`src/docgen.js`** — `generateDoc` gains an options argument used only by
replay: `notify: false` (a scratch draft must not mail Brandon a "draft ready"
notice) and a `— REPLAY` name suffix so it is tellable from the real draft beside
it. Absent options, every default is the live pipeline's existing behaviour.

**Fixtures** — deferred to Phase 1, which is where the `DocumentApp` body double
that would consume one gets built. `extraction.json` only starts appearing on
runs after this phase deploys, so the first one comes either from the next real
call or from `logServerOnly('extraction.response')` in Cloud Logging. Redact the
insured name, address, phone, carrier, and claim number before committing.

**Tests** — `replay.test.ts` wires `extractFields`, `runTranscriptionPass`, and
`UrlFetchApp.fetch` to throw, so the free path is proven free by construction
rather than by counting calls afterwards. `sandbox.test.ts` asserts the unit-test
`vm` context exposes no network-capable global and that the real
`callOpenRouter` path throws `UrlFetchApp is not defined` inside it.
`runner.test.ts` asserts the pipeline persists the artifact.

### Phase 1 — Every heard citation is highlighted

**`src/docgen.js`**

- Delete `REVIEW_MARK_START` / `REVIEW_MARK_END` and `highlightMediumConfidence`.
- `markForReview(text, sourceSpan, label)` returns a plain-text marker:
  - with a span: `text + ' [heard: "<sanitized span>"]'`
  - without one (a medium-confidence variant, whose canned text has no span):
    `text + ' [review: <label> — medium confidence, no transcript citation]'`.
    This replaces today's fallback of wrapping the entire variant text, which
    would have painted a whole expanded section — including nested tags filled in
    by pass 2, e.g. the full room-by-room interior narrative — yellow.
- `sanitizeSpan(span)` strips `[` and `]` (an unbalanced bracket in a transcribed
  span breaks the `[^\]]*` match and silently kills the highlight for that field),
  collapses whitespace, and truncates to 200 characters with an ellipsis.
- Replace `highlightNeedsInput` with `highlightMarkers(body)`, one pass over
  `\[(NEEDS INPUT|heard|review):[^\]]*\]`, setting `#FFFF00`. Markers stay in the
  document text — they are notes to Brandon, identical in kind to `[NEEDS INPUT]`,
  and he deletes them as he reviews.
- `countNeedsInput` is unchanged: it counts invalid fields and variant branches
  whose canned text embeds `[NEEDS INPUT:`. `[heard:` and `[review:` markers must
  not inflate the header count.

**Tests (`tests/unit/adjuster/docgen.test.ts`)**

The existing suite tests `markForReview` as a pure string function, which is
precisely why this bug shipped green. Add a minimal `DocumentApp` body double
(`getText`, `findText(pattern, from)`, `editAsText`/`asText`,
`setBackgroundColor`) and assert:

- a medium-confidence field's `[heard: "..."]` is highlighted and its real
  sentence is not;
- a `[NEEDS INPUT: ... — heard: "..."]` placeholder is highlighted whole;
- a span containing `]` still highlights;
- no rendered text contains a character below `\x20` other than `\n`.

### Phase 2 — A missing value is never an invisible gap

Three layers so it cannot regress, in `src/docgen.js` and `template/enums.json`:

1. **Schema lint.** A new test fails if any variant option has empty or
   whitespace-only `text`. `mitigation_status: none` is the current violation
   (fixed in Phase 6).
2. **Render backstop.** In `resolveTagsForDoc`, a **required** field that resolves
   to empty or whitespace-only text becomes `[NEEDS INPUT: <label>]`. Optional
   fields are still allowed to render nothing.
3. **Residue cleanup.** A new `tidyRendering(body)` runs after both replacement
   passes and **before** `highlightMarkers` (it shifts offsets), collapsing what an
   omitted optional field leaves behind: `[ ]{2,}` → single space, ` .` → `.`,
   ` ,` → `,`, `,[ ]*,` → `,`, and trailing spaces before a newline. The only
   always-visible optional field today is `coverage_supporting_detail`, which sits
   mid-sentence inside all three coverage branches and leaves a double space when
   omitted.

`generateDoc`'s order becomes: variant pass → leaf pass → `tidyRendering` →
`styleRoomLabels` → `highlightMarkers` → `appendUnplacedNotes`.

Known cosmetic side effect: a doubled space inside a quoted `[heard: "..."]` span
is collapsed by `tidyRendering`. Accepted — the citation is a review hint, not
evidence of record.

### Phase 3 — Clause fields render as part of a coherent sentence

**`template/enums.json`** — add `"form": "clause"` to `origin_narrative`,
`origin_damage_narrative`, `coverage_cause_narrative`, `subrogation_reason`.

**`src/docgen.js`** — `normalizeClause(value, claim)`, applied in
`resolveTagsForDoc` when `schema.form === 'clause'`:

1. Trim.
2. Strip one trailing `.`.
3. Strip a leading stock prefix, case-insensitively:
   `damage occurred due to`, `due to`, `resulting in damage to`,
   `the damage(s) was/were caused by`.
4. Lowercase the first character, **unless** the first word is all-caps or matches
   a proper noun from the matched claim row (insured last name, carrier, contact
   names). `claim` is already in scope in `generateDoc` and gets threaded into
   `resolveTagsForDoc`.
5. **Reject** — render `[NEEDS INPUT: <label> — heard: "<span>"]` instead of the
   value — when the normalized result still contains a sentence boundary
   (`/[.!?]\s+[A-Z]/` or a trailing `!`/`?`) or an explicit date
   (`\b\d{1,2}/\d{1,2}/\d{2,4}\b` or a month name). Dates are a merge field
   (`[DATE_LOSS]`) and print twice if a clause carries one.
6. A rejected value is not discarded: `resolveTagsForDoc` returns
   `{ resolved, salvaged }` and `generateDoc` concatenates `salvaged` into
   `unplacedNotes` before `appendUnplacedNotes`, as
   `'<label>, as extracted: "<value>"'`.

**`src/prompt.js`** — reinforce the existing clause guidance with the explicit
negative: do not begin with "Damage occurred due to", no leading capital, no
trailing period.

**Tests** — `docgen.test.ts` for each normalizer rule and both reject paths,
including the proper-noun exception; `prompt.test.ts` for the added guidance.

### Phase 4 — The coverage paragraph stops repeating itself

The observed sentence decomposes as
`cause` (`storm related`) + branch head (`which is covered under the insured's
policy.`) + **`coverage_supporting_detail`** (`Because it is a storm that caused
the lightning strike, the claim is covered.`) + branch tail (`Therefore, there
are no coverage concerns that would affect this claim.`). `coverage_cause_narrative`
and `coverage_determination` are genuinely separate fields and are not the
problem; the model filled the optional "extra fact" slot with a restatement of
both.

**`src/prompt.js`** — rewrite `coverage_supporting_detail` guidance by exclusion:
an _independent_ policy fact not derivable from the cause or the determination
(heat maintained through a freeze, policy in lapsed status, a prior claim on the
same peril). Default is empty; when nothing independent was said, leave it empty.

**`src/validate.js`** — a new `dropCoverageRestatement(validated)` post-pass,
called in `runner.js`'s extraction stage alongside the calendar and claim-property
fallbacks. Returns `{ validated, dropped }`; when it drops, the field becomes
`omitted(label)` and `dropped` is appended to `unplacedNotes` so nothing said on
the call is lost. Also emits `logEvent('docgen.coverage_detail_dropped', {...})`.

Two detectors:

- **Determination restatement** — `/\b(is|are|was|were)\s+(covered|excluded)\b/i`,
  `/\bcoverage\s+(applies|does not apply|is applicable)\b/i`,
  `/\bthe claim is (covered|denied|excluded)\b/i`, `/\bno coverage concerns\b/i`.
- **Cause restatement** — content-token overlap (lowercased, stopwords removed)
  against `coverage_cause_narrative`; drop when ≥60% of the cause's content tokens
  appear in the detail.

One exception: when `coverage_determination` is `unknown`, the supporting detail
_is_ the reason coverage is in question and may legitimately use coverage
vocabulary ("The policy was in a lapsed status on the date of loss"). Apply only
the cause-overlap detector on that branch.

**Tests** — `validate.test.ts` for both detectors, the `unknown` exception, the
salvage path, and a legitimate detail (`Heat was maintained in the home
throughout the freeze event.`) surviving untouched.

### Phase 5 — Enums become suggestions

**`template/enums.json`** — seven fields change `"type": "enum"` → `"type":
"string"` with `"suggestions"` carrying the identical list:
`dwelling_type`, `foundation_type`, `siding_type`, `occupancy_status`,
`roof_covering_type`, `roof_condition`, `roof_pitch`.

**`src/prompt.js`**

- `formatTagList` renders `— common values (suggestions, not a closed list): ...`
  for a field with `suggestions`, and keeps exact-match wording for variants.
- The system prompt's enum paragraph splits: variant values must match a listed
  key character for character; suggestion fields prefer a listed value but use the
  adjuster's own words when none fit.
- Each suggestion field gains `FIELD_GUIDANCE` naming the grammatical slot it
  fills, because a free-text value now has to fit a fixed sentence — e.g.
  `siding_type` completes `The dwelling is wood framed with ___, and composition
shingle roofing.` and must be a noun phrase; `occupancy_status` completes
  `The home is currently occupied by ___.`

**`src/validate.js`** — remove the enum set-membership rejection from
`validateFields`, `validateLiveFields`, `applyCalendarFallback`, and
`applyClaimPropertyFallback`. In `validateLiveFields`, a field carrying
`suggestions` is trusted the same way an enum was (per the Architecture decision
above); a plain string or narrative field with no `suggestions` list still routes
to manual review.

**Vocabulary signal** — whenever a field with `suggestions` validates to a value
that is not in its list, emit
`logEvent('extraction.off_suggestion', { capture_id, tag, value, source })` from
the validation pass. These land on the Raw log sheet and are read periodically to
grow the lists from real calls. This is the point of opening the vocabularies:
the list stops being a gate and becomes a record of what adjusters actually say.

**Tests** — `validate.test.ts` (off-list value is valid; live-extracted
suggestion field is trusted; a narrative live field still routes to needs-input;
the `off_suggestion` event fires), `prompt.test.ts` (suggestion wording, variant
wording unchanged).

### Phase 6 — Mitigation always renders a section

The `MITIGATION:` heading currently lives _inside_ the variant's `present` text,
and the `none` branch is `""` — so "no mitigation vendor" produces an empty line
where the whole section belongs: no heading, no sentence, no flag.

**`template/template.flattened.txt`** — add a `MITIGATION:` heading line above
`{{mitigation_status}}`, matching every other section.

**`template/enums.json`** — `mitigation_status` branches become:

- `none` → `"No mitigation services were performed on this loss."`
- `present` → `"{{mitigation_narrative}}"` (heading removed)

**Live Doc edit** — the same heading line added to `TEMPLATE_DOC_ID` by hand.

**Tests** — `template.test.ts` asserts the heading is in the flattened template
and not in either branch text; the Phase 2 schema lint covers the non-empty rule.

## Verification without vendor spend

The previous feature was verified with roughly 20 injections through
`scripts/adjuster-inject-test-job.mjs`. That script posts to the live web app and
the next runner tick runs the **entire** pipeline, so each injection bought two
batch ASR calls (ElevenLabs Scribe + Qwen), one long-context master-transcript
merge, one extraction call, and — on an ambiguous match — an `llmMatcher` call.
Nothing about this spec needs any of that.

| Phase                  | Verified by                                                           | Vendor calls |
| ---------------------- | --------------------------------------------------------------------- | ------------ |
| 0 replay harness       | `replay.test.ts` + one editor run                                     | 0            |
| 1 heard highlighting   | `docgen.test.ts` body double + `regenerateDraftFromArtifacts`         | 0            |
| 2 never blank          | same                                                                  | 0            |
| 3 clause normalizer    | `docgen.test.ts` (deterministic) + `prompt.test.ts` string assertions | 0            |
| 4 coverage dedupe      | `validate.test.ts` (deterministic) + `prompt.test.ts`                 | 0            |
| 5 enums -> suggestions | `validate.test.ts` + **one** `reExtractFromArtifacts` run             | **1**        |
| 6 mitigation           | `template.test.ts` + `regenerateDraftFromArtifacts`                   | 0            |

**Total budget for this spec: one OpenRouter extraction call.** If Phase 5's
prompt wording needs a second attempt, that is a second call — not a second
pipeline run. Anything beyond that is a signal to stop and re-plan, not to keep
injecting.

Structural guarantees, not just discipline:

- Unit tests cannot reach a vendor. `loadGs` builds a `vm` context holding only
  `console` plus explicitly passed globals, so `UrlFetchApp` is undefined and an
  accidental call is a `ReferenceError` at test time, never a charge. Add an
  explicit test asserting the sandbox exposes no fetch-capable global, so this
  stays true.
- `regenerateDraftFromArtifacts` never enters `runTranscriptionStage` or
  `extractFields`, so the zero-cost path is zero-cost by construction rather than
  by remembering which function to call.
- Add a cost note to `scripts/adjuster-inject-test-job.mjs`'s header comment
  naming what one injection spends and pointing at the replay harness, so the next
  person reaches for the free path first.

## Edge Cases & Risk

| Risk                                                                                                                              | Likelihood | Impact | Mitigation                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live Doc and `template.flattened.txt` drift again (Phase 6 heading not added to the Doc)                                          | M          | H      | `findLeftoverTags` already fails the job on an unreplaced tag; the heading itself is static text, so add a post-generation check that `MITIGATION:` is present in the body |
| `tidyRendering`'s `[ ]{2,}` pass alters text inside a quoted `[heard: "..."]` span                                                | H          | L      | Accepted and documented — the citation is a review hint, not evidence of record                                                                                            |
| Clause normalizer lowercases a genuine proper noun the claim row does not know (a vendor named only on the call)                  | M          | L      | Cosmetic only; the all-caps and claim-proper-noun exceptions cover the common cases                                                                                        |
| Clause reject path fires on a legitimate value and adds a `[NEEDS INPUT]` where the old code printed something usable             | M          | M      | Rejected text is salvaged into "Not placed" so Brandon can paste it back; reject only on a sentence boundary or a date, both of which print badly today anyway             |
| Coverage cause-overlap detector drops a legitimate supporting detail that happens to share vocabulary with the cause              | M          | M      | 60% threshold on content tokens only; dropped text is salvaged into "Not placed" and logged, never silently deleted                                                        |
| Open vocabularies let a badly-fitting free-text value into a fixed template sentence (e.g. `siding_type: "the siding was vinyl"`) | M          | M      | Per-field `FIELD_GUIDANCE` naming the grammatical slot; `off_suggestion` logging makes bad fits visible in review                                                          |
| Trusting live-extracted suggestion values admits a Dograh/Retell value with no transcript corroboration                           | M          | M      | Explicitly chosen; unchanged in kind from today (these seven were already trusted as enums) and confined to closed-form property facts                                     |
| `enums.json` edited without a matching sync payload, so production keeps the old schema                                           | L          | H      | `templateData.test.ts` byte-parity check already fails the build; deploy checklist below                                                                                   |
| Verification drifts back to full-pipeline injections and re-runs vendor calls per iteration                                       | M          | M      | Phase 0 ships first and every later phase is verified through it; per-phase call budget in "Verification without vendor spend"; cost note added to the inject script       |
| Committed fixture carries unredacted claim PII into the repo                                                                      | M          | H      | Redact insured name, address, phone, carrier, and claim number when capturing the fixture; review the diff before committing                                               |

## Acceptance Criteria

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` all pass
- [ ] No hardcoded secrets; no `.env` committed
- [ ] `docgen.js` contains no ASCII control characters, and a `DocumentApp` body
      double in `docgen.test.ts` proves both marker kinds are painted `#FFFF00`
- [ ] A medium-confidence field renders its real sentence unhighlighted and its
      `[heard: "..."]` citation highlighted
- [ ] A medium-confidence _variant_ appends a `[review: ...]` marker rather than
      wrapping its whole expanded branch
- [ ] Schema lint test fails on any variant option with empty `text`
- [ ] A required field resolving to empty renders `[NEEDS INPUT: <label>]`
- [ ] An omitted `coverage_supporting_detail` leaves no double space in the
      rendered coverage paragraph
- [ ] `A severe storm.` as `origin_narrative` normalizes to `a severe storm` and
      renders as `Damage occurred due to a severe storm on [DATE_LOSS], ...`
- [ ] `A severe storm damaged the roof. Water then entered the attic.` rejects,
      rendering `[NEEDS INPUT: Cause of loss — heard: "..."]` with the raw value
      salvaged into "Not placed"
- [ ] `a wind driven rain event` passes the normalizer unchanged
- [ ] A `coverage_supporting_detail` restating the cause or the determination is
      dropped, salvaged into "Not placed", and logged
      `docgen.coverage_detail_dropped`
- [ ] `Heat was maintained in the home throughout the freeze event.` survives as a
      supporting detail
- [ ] An off-list `siding_type` (e.g. `board and batten siding`) validates,
      renders, and emits `extraction.off_suggestion`
- [ ] A live-extracted (Dograh/Retell) suggestion field is trusted; a live-extracted
      narrative field still routes to needs-input
- [ ] `mitigation_status: none` renders `MITIGATION:` followed by
      `No mitigation services were performed on this loss.`
- [ ] `template/enums.json` and `template/template.flattened.txt` re-diffed against
      the live Doc immediately before upload
- [ ] Exactly one `syncEnumsFileFromRepo_*()` in `templateData.js`, byte-parity test
      passing; `syncEnumsFileFromRepo_20260901()` deleted
- [ ] `syncEnumsFileFromRepo_20260902()` run once from the Apps Script editor, then
      deleted in a follow-up commit
- [ ] Live Doc `MITIGATION:` heading added by hand
- [ ] `clasp push` + `clasp deploy` run against the live deployment
- [ ] `runExtractionStage` writes `extraction.json` to the call folder
- [ ] `regenerateDraftFromArtifacts` produces a draft without calling
      `extractFields` or any transcription function, proven by `replay.test.ts`
- [ ] Sandbox test asserts unit tests expose no fetch-capable global
- [ ] Cost note added to `scripts/adjuster-inject-test-job.mjs`
- [ ] One `regenerateDraftFromArtifacts` draft (0 vendor calls) confirms: every
      `[heard: ...]` is yellow, no section renders blank, the origin sentence
      reads cleanly, and the coverage paragraph states the cause and the
      determination once each
- [ ] One `reExtractFromArtifacts` run (1 OpenRouter call, the spec's entire
      vendor budget) confirms an off-list spoken value renders instead of flagging
- [ ] `scripts/adjuster-inject-test-job.mjs` was not run during this spec

## Deferred

- **`composition shingle roofing` is hardcoded** in the Risk Information sentence
  and prints on metal-roof claims, contradicting `roof_status: other_material`.
  It needs its own tag and a template edit — separate change, separate live Doc
  edit.
