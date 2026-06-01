# Submittal-Fit Grade UI

**Status:** Implemented — PR #3
**Owner:** CareerSystems / portal
**Last updated:** 2026-06-01

## Objective

Spec 007 added a `grade` envelope and `assessment` object to the `submittal-fit`
API response — the backend now tells the portal whether to ship, soft-warn, or
route to human review. The portal currently ignores both fields. This spec wires
them into `ResumeTemplaterPage` with a grade banner, a collapsible recruiter
assessment panel, and a soft export gate. No new pages, no routing changes, no
backend work.

## Non-goals

- Hard-blocking export. Recruiters must always retain override authority.
- Displaying gaps, `fit_level`, or `must_have_coverage` in the exported docx
  (those are recruiter-only; spec 007 already ensures no mustache tags exist).
- Triggering a new `submittal-fit` call from within the portal on
  `action = 'regenerate'` automatically — this edition shows the banner with
  a manual "Regenerate" button that re-fires the existing generate flow.
- Backend changes. `submittal-fit` is already returning the new fields.
- Mobile optimisation. Portal is desktop-first; do not add `lg:` breakpoints.
- Persisting grade/assessment to the database.

## Business Rationale

Recruiters currently export every submittal with no signal on quality. The
grader gives them a structured "ship / review" signal, but only if the portal
surfaces it. Without this UI layer, spec 007 delivers no recruiter value. This
spec closes that loop with minimal code: two new presentational sub-components
plus state additions to an existing page.

## Architecture

### New types (`apps/portal/src/lib/submittalTypes.ts` — new file)

Extract shared types here so `ResumeTemplaterPage` and its test file stay clean:

```ts
export type GradeAction = 'ship' | 'regenerate' | 'human_review'
export type FailureClass = 'hallucination' | 'structural' | 'none'

export interface FitGrade {
  action: GradeAction
  failure_class: FailureClass
  issues: string[]
  warnings: string[]
}

export interface MustHaveCoverage {
  requirement: string
  met: boolean
  evidence: string | null
}

export interface FitAssessment {
  fit_level: 'strong' | 'moderate' | 'weak' | 'not_recommended'
  jd_must_haves: string[]
  must_have_coverage: MustHaveCoverage[]
  gaps: string[]
}
```

No `unknown` types. All fields are required (the API always returns both objects
after spec 007 — a missing `grade` is treated as `{ action: 'ship', failure_class: 'none', issues: [], warnings: [] }`
defensively).

### State additions to `ResumeTemplaterPage`

Two new pieces of React state, alongside the existing `fitBullets`/`fitSummary`:

```ts
const [fitGrade, setFitGrade] = useState<FitGrade | null>(null)
const [fitAssessment, setFitAssessment] = useState<FitAssessment | null>(null)
```

Set from the API response:

```ts
setFitGrade(data.grade ?? null)
setFitAssessment(data.assessment ?? null)
```

Both reset to `null` when a new generate call starts (so stale grades from a
previous run are not shown while a new one is in flight).

### New sub-components

Both live inside `ResumeTemplaterPage.tsx` as local components (not exported,
not moved to `@cs/ui` — they're too page-specific for the shared library).

#### `<GradeBanner grade={fitGrade} onRegenerate={handleGenerate} />`

Renders above the recruiter assessment panel and above the editable fit content.
Four states:

| `grade.action`   | `grade.failure_class` | `grade.warnings` | Visual                                                                             |
| ---------------- | --------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `'ship'`         | any                   | empty            | Nothing rendered                                                                   |
| `'ship'`         | any                   | non-empty        | Yellow/amber banner listing each warning                                           |
| `'human_review'` | `'structural'`        | any              | Orange banner — "This submittal was flagged for human review" + `issues` list      |
| `'human_review'` | `'hallucination'`     | any              | Red banner — "Content could not be verified" + `issues` list + "Regenerate" button |

`null` grade renders nothing.

Tailwind classes (no custom colours; these are status banners, not constraint
type indicators so `constraint.*` tokens are off-limits per the design skill):

- Warnings: `bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4`
- Structural human_review: `bg-orange-50 border border-orange-200 text-orange-800 rounded-lg p-4`
- Hallucination: `bg-red-50 border border-red-200 text-red-800 rounded-lg p-4`

The "Regenerate" button on the hallucination banner uses `<Button variant="outline" size="sm">`.
It calls `onRegenerate()` which re-fires the existing generate handler — no new
API logic.

#### `<RecruiterAssessment assessment={fitAssessment} />`

Collapsible panel, **open by default when `assessment.fit_level` is not `'strong'`**,
closed by default otherwise. Uses a local `useState<boolean>` for open/closed.

Renders:

- Header row: "Recruiter assessment" label (left, `text-sm font-semibold
text-cs-muted`) + fit_level badge (right) + chevron toggle (inline SVG, 24×24).
- When open: a list of `assessment.gaps`, each as a `text-sm text-cs-text` bullet.
  If gaps is empty and the panel is open, show "No gaps identified."

Fit-level badge uses inline Tailwind (Badge component has no success/warning/danger
variant — do not add one to `@cs/ui` for this feature):

| `fit_level`         | Classes                         |
| ------------------- | ------------------------------- |
| `'strong'`          | `bg-green-100 text-green-800`   |
| `'moderate'`        | `bg-amber-100 text-amber-800`   |
| `'weak'`            | `bg-orange-100 text-orange-800` |
| `'not_recommended'` | `bg-red-100 text-red-800`       |

Common classes: `text-xs font-semibold uppercase px-2 py-0.5 rounded-full`.

This panel is rendered in the JSX only — it has no mustache template and is
never passed to `exportSubmittal()`. The existing export path is unchanged.

### Soft export gate

When `fitGrade?.action === 'human_review'` the export button click shows a
confirmation dialog before proceeding. Implementation: a local boolean state
`confirmExportOpen` + a simple inline modal (a `<div>` overlay, not a new
`@cs/ui` component):

Dialog copy:

> **Export flagged submittal?**
> This submittal was flagged for human review. The recruiter should verify the
> content before sending to a hiring manager.
> [Cancel] [Export anyway]

"Export anyway" calls `exportSubmittal()` and closes the dialog.
"Cancel" closes without exporting.

When `action` is `'ship'` or `null`, the existing export button behavior is
unchanged (no confirmation).

### Component layout (render order in `ResumeTemplaterPage`)

```
<GradeBanner />          ← new, above assessment
<RecruiterAssessment />  ← new, below banner, above editable content
[existing fit content]   ← fit_summary, fit_bullets, key_qualifications
```

### No shared package impact

All new components are local to `ResumeTemplaterPage.tsx`. `@cs/ui` is not
modified. `submittalExport.ts` is not modified.

### No ADR required

Pure UI wiring — no architecture decision, no schema change, no new edge function.

## Implementation Phases

### Phase 1 — Types + state + banner

- Create `apps/portal/src/lib/submittalTypes.ts` with `FitGrade`, `FitAssessment`,
  `MustHaveCoverage` types.
- Add `fitGrade` / `fitAssessment` state to `ResumeTemplaterPage`; wire to API
  response; reset to `null` on new generate call.
- Implement `<GradeBanner>` local component (all four states).
- Unit tests: `GradeBanner` renders correctly for each of the four grade states
  (ship/clean, ship/warnings, human_review/structural, human_review/hallucination).

### Phase 2 — Recruiter assessment panel + export gate

- Implement `<RecruiterAssessment>` local component (collapsible, fit_level badge,
  gaps list, default-open logic).
- Implement soft export gate (`confirmExportOpen` state + inline confirmation
  dialog).
- Unit tests: `RecruiterAssessment` renders fit_level badge correctly, collapses/
  expands, shows gaps; export gate shows confirmation when `action = 'human_review'`
  and skips it when `action = 'ship'`.
- Update `ResumeTemplaterPage.test.tsx` to assert `grade` and `assessment` are
  read from the API mock response.

## Edge Cases & Risk

| Risk                                                                   | Likelihood | Impact | Mitigation                                                                           |
| ---------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------ |
| API returns no `grade` field (old backend / feature off)               | L          | L      | Defensive `?? null` fallback; null grade renders nothing                             |
| API returns no `assessment` field                                      | L          | L      | Same `?? null` fallback; panel renders nothing                                       |
| Recruiter dismisses banner and forgets to review                       | M          | M      | Panel stays visible (no dismiss on human_review banner) until a new generate run     |
| Gaps accidentally rendered in exported docx                            | L          | H      | Export path (`submittalExport.ts`) is not modified; assessment is never passed to it |
| Stale grade from previous run shown while regenerating                 | M          | L      | Reset `fitGrade`/`fitAssessment` to `null` at the top of the generate handler        |
| Hallucination banner "Regenerate" fires on an already-loading generate | M          | L      | Disable "Regenerate" button when `isGenerating` is true (existing flag)              |

## Acceptance Criteria

- [ ] `submittalTypes.ts` exports `FitGrade`, `FitAssessment`, `MustHaveCoverage`
      with no `unknown` types.
- [ ] `fitGrade` and `fitAssessment` are set from the API response and reset to
      `null` when a new generate call starts.
- [ ] `GradeBanner` renders nothing for `action = 'ship'` with no warnings.
- [ ] `GradeBanner` renders a yellow/amber banner listing `grade.warnings` for
      `action = 'ship'` with warnings.
- [ ] `GradeBanner` renders an orange banner with `issues` for
      `action = 'human_review'`, `failure_class = 'structural'`.
- [ ] `GradeBanner` renders a red banner with `issues` + "Regenerate" button for
      `action = 'human_review'`, `failure_class = 'hallucination'`; clicking
      "Regenerate" re-fires the generate flow; button is disabled while generating.
- [ ] `RecruiterAssessment` renders a fit_level badge with correct colour per level.
- [ ] `RecruiterAssessment` is open by default when `fit_level !== 'strong'`.
- [ ] `RecruiterAssessment` lists gaps; shows "No gaps identified." when empty.
- [ ] Export flow shows confirmation dialog when `fitGrade.action = 'human_review'`;
      "Export anyway" proceeds; "Cancel" does not export.
- [ ] Export flow requires no confirmation when `fitGrade` is `null` or
      `action = 'ship'`.
- [ ] Assessment data is never passed to `exportSubmittal()` or the docx template.
- [ ] Unit tests cover all banner states, assessment panel, and export gate logic.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass.
