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
