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
