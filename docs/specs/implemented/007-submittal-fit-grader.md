# Submittal-Fit Honesty Grader (Generator + Layered Gate)

**Status:** Implemented — PR https://github.com/Blaze212/fractional/pull/2
**Owner:** CareerSystems / submittal-fit
**Last updated:** 2026-06-01

## Objective

The `submittal-fit` generator today behaves like a salesperson: it is only
asked _why this candidate fits_, so it over-praises every candidate and never
surfaces gaps. We will turn it into a two-layer system. **Layer 1 (generator)**
is forced to extract the JD's must-haves, score the candidate against them, emit
an honest `fit_level`, and record internal-only gaps — alongside the existing
client-facing narrative. **Layer 2 (grader)** is a layered gate: cheap
deterministic checks always run, and a skeptical LLM grader runs _conditionally_
(only when risk is detected) to catch non-numeric hallucinations and dishonest
self-assessment. The endpoint returns the narrative wrapped in a `grade`
envelope so the portal can ship, soft-warn, or route to human review. This
extends the grounding philosophy already present in `findUnsupportedNumbers`
(a deterministic numeric-hallucination gate) to non-numeric facts and fit
honesty.

## Non-goals

- Rendering gaps or `fit_level` into the client-facing submittal docx. Gaps are
  **internal-only** (recruiter-facing) and must never reach the hiring manager.
- Replacing or merging the offline eval scorecard (`tests/eval/scorecard.ts`).
  That stays a continuous 1–10 regression metric for A/B prompt comparison; the
  prod grader is a separate categorical gate. They share only the
  "facts-only-from-profile" prompt framing.
- Portal UI implementation of the banner/edit-gating. This spec defines the
  response contract and ships the backend; the portal consuming the `grade`
  envelope is a follow-up (Phase 4 stubs it behind a feature check).
- Multi-candidate / batch grading. One candidate per request, as today.
- Changing the auth model. `submittal-fit` stays `withAuth` + `verify_jwt = false`.

## Business Rationale

Submittals go to real hiring managers at client companies. An over-praising or
factually loose submittal is a reputational and legal risk for the agency
(already called out in the system prompt). Recruiters currently have no signal
when the model has stretched the truth or when a candidate is a weak fit — they
must catch it by hand. A grader that (a) forces honest self-assessment and
(b) independently verifies it gives recruiters a trustworthy "ship / review"
signal and de-risks the agency's outbound.

## Architecture

### Layering model

| Layer                             | Cost                     | When            | Responsibility                                                                                                                                                |
| --------------------------------- | ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — deterministic**             | free                     | always          | schema/count checks (have), numeric grounding (have), banned-phrase × `fit_level` contradiction (new), `must_have_coverage` × `fit_level` contradiction (new) |
| **1 — generator self-assessment** | ~free (same call)        | always          | extract `jd_must_haves`, score `must_have_coverage`, emit `fit_level` + `internal_assessment.gaps`                                                            |
| **2 — LLM grader**                | 1 extra call (`gpt-5.4`) | **conditional** | independently re-derive coverage, compare to generator's claim, detect non-numeric hallucination, classify failure                                            |

**Risk gate (when Layer 2 runs):** Layer 2 is invoked only when Layer 0 + the
generator's self-assessment smell risky:

```
runLayer2 =
     fit_level !== 'strong'
  || internal_assessment.gaps.length > 0
  || layer0 produced any contradiction or banned-phrase hit
```

When all are clean the request returns `action: 'ship'` after Layer 0 only —
the easy majority of submittals skip the second call. **Load-bearing detail:**
the `must_have_coverage` × `fit_level` contradiction check (Layer 0) is the
backstop that stops a sycophantic generator from labelling everything `strong`
to route around the grader — a `strong` claim with any unmet must-have forces
Layer 2 regardless.

### Schema changes (`submittal-fit/schema.ts`)

`FitResult` gains internal fields. The **client-facing trio**
(`fit_bullets`, `key_qualifications`, `fit_summary`) is unchanged in shape.

```ts
type FitLevel = 'strong' | 'moderate' | 'weak' | 'not_recommended'

interface MustHaveCoverage {
  requirement: string // verbatim-ish from the JD
  met: boolean
  evidence: string | null // source_ref-style pointer into the profile, or null when unmet
}

interface FitResult {
  // client-facing (unchanged)
  fit_bullets: FitBullet[] // exactly 3
  key_qualifications: FitBullet[] // 0–5
  fit_summary: string
  // new — internal / assessment
  jd_must_haves: string[]
  must_have_coverage: MustHaveCoverage[]
  fit_level: FitLevel
  internal_assessment: { gaps: string[] }
}
```

`FIT_RESULT_SCHEMA` (JSON Schema, `strict: true`, `additionalProperties: false`)
is extended to match. `fit_level` uses an `enum`. No `unknown` types.

**`fit_level` rubric** (encoded in the system prompt, enforceable against
`must_have_coverage`):

- `strong` — meets ≥80% of must-haves, no fatal gaps
- `moderate` — meets some must-haves, 1–2 meaningful gaps
- `weak` — misses multiple must-haves, partial overlap only
- `not_recommended` — lacks core must-haves

### Grader contract (new `submittal-fit/fit-grader.ts`)

No `Deno.serve()` in this file (it is imported by `submittal-fit.ts`; see the
Module Isolation rule in CLAUDE.md). Pure function + a `Deps`-injected AI client.

```ts
type GradeAction = 'ship' | 'regenerate' | 'human_review'
type FailureClass = 'hallucination' | 'structural' | 'none'

interface FitGrade {
  action: GradeAction
  failure_class: FailureClass
  issues: string[] // hard problems — block ship
  warnings: string[] // soft — yellow banner
}
```

The LLM grader prompt: given JD + profile + generator output, it (1)
**independently** re-derives must-have coverage from JD+profile _before_ being
shown the generator's claim, then (2) compares to the generator's
`must_have_coverage` / `fit_level` and flags under-reported gaps, then (3) checks
every employer, title, and tool in the narrative against the profile for
non-numeric hallucination. Output is the categorical `FitGrade` via strict
`json_schema`. Reuses the "facts only from the profile" framing shared with
`scorecard.ts` (extract a small shared prompt helper rather than duplicate).

### Failure behavior — split by class

- **`hallucination`** (transient — a retry may fix it): the existing numeric
  hard-fail folds into this class. Allow **exactly one** auto-regenerate of the
  generator call. If the second attempt still fails, do **not** throw — return
  `{ result, grade: { action: 'human_review', failure_class: 'hallucination', ... } }`
  so the recruiter sees _why_ rather than an opaque 422.
- **`structural`** (weak fit / missing must-haves — regenerating won't change
  the truth): never retry. Return the narrative with
  `action: 'human_review'`, `failure_class: 'structural'`.
- **clean / warnings-only:** `action: 'ship'`, optional `warnings[]` for a
  yellow banner.

This replaces the current behavior where ungrounded numbers `throw`
`UnprocessableEntityException`. **Schema/shape validation failures**
(wrong bullet count, empty summary) still throw `UnprocessableEntityException`
as today — those are contract violations, not gradeable content.

### Response contract (`submittal-fit/index.ts`) — BACKWARDS-INCOMPATIBLE

The 200 body gains a `grade` envelope:

```jsonc
{
  "fit_bullets": [...],
  "fit_summary": "...",
  "key_qualifications": [...],
  "grade": { "action": "ship", "failure_class": "none", "issues": [], "warnings": [] },
  "meta": { "model": "..." }
}
```

`jd_must_haves`, `must_have_coverage`, `fit_level`, and `internal_assessment`
are **also** returned (recruiter-facing internal data) but live under an
`assessment` key, not at the top level, to keep client-facing vs internal
visually separated for portal consumers:

```jsonc
"assessment": { "fit_level": "moderate", "jd_must_haves": [...], "must_have_coverage": [...], "gaps": [...] }
```

> **Backwards-incompatibility call-out (per CLAUDE.md):** existing portal code
> reads `fit_bullets` / `fit_summary` / `key_qualifications`, which are
> unchanged, so existing clients keep working — the change is **additive** at
> the top level. The only behavioral change is that ungrounded-number cases
> that previously returned a 422 now return 200 with
> `grade.action = 'human_review'`. Any client relying on that 422 to mean
> "blocked" must switch to checking `grade.action`. This is shipped in Phase 1
> ahead of the portal consuming it (Phase 4).

### Export path (`scripts/prepare-submittal-template.ts`)

The docx template renders only `{{fit_summary}}`, `{{#fit_bullets}}`,
`{{#key_qualifications}}` (verified via grep). The new internal fields have no
mustache tags and therefore cannot render into the client docx by construction.
Phase 3 adds a test asserting the rendered template contains no gap/fit_level
content, so a future template edit can't silently leak internal data.

### Eval harness (`tests/eval/`)

Two distinct eval concerns:

1. **Generator eval (existing scorecard):** unchanged. New `FitResult` fields
   flow through `provider.ts` automatically; `scorecard.ts` ignores them.
2. **Grader eval (new):** labeled fixtures asserting precision/recall on
   `grade.action`. The existing `bh-scrum-master-gpu.yaml` fixture (SWE with
   Agile experience but **no Scrum cert** vs a JD that requires PSM/CSM) is a
   ready-made `structural` / `human_review` label. Add at least one
   known-`strong` (ship) fixture and one synthetic known-hallucination fixture.

### Models / env

- Generator: `SUBMITTAL_FIT_MODEL` (default `gpt-5.4-mini`) — unchanged.
- Grader: new `SUBMITTAL_FIT_GRADER_MODEL` (default `gpt-5.4`), read in
  `index.ts` via the same `Deno.env.get(...) ?? DEFAULT` pattern, injected into
  the grader through `Deps`. Doppler-managed; no hardcoded secrets.

This warrants an ADR (new feature + backwards-incompatible response contract):
`docs/adr/NNNN-submittal-fit-grader.md`.

## Implementation Phases

### Phase 1 — Schema + generator self-assessment (deployable alone)

- `schema.ts`: add `jd_must_haves`, `must_have_coverage`, `fit_level`,
  `internal_assessment`; extend `FIT_RESULT_SCHEMA` (strict, enum).
- `system-prompt.ts`: add must-have extraction instruction + `fit_level` rubric
  - explicit permission to return `moderate`/`weak`/`not_recommended`. Keep the
    "no hype unless strong" rule (also enforced in Layer 0).
- `index.ts`: surface the new fields under `assessment`. No grader yet (Layer 2
  off); `grade` defaults to `{ action: 'ship', failure_class: 'none', ... }`
  after Layer 0.
- Tests: unit tests for schema validation and for the generator output shape
  (mocked AI client returning a fixture `FitResult`).

### Phase 2 — Layer 0 deterministic checks + Layer 2 grader

- New `fit-grader.ts` (no `Deno.serve()`): `gradeFit(input, output, deps, log)`.
  - Layer 0 (pure, no LLM, individually unit-tested): banned-phrase ×
    `fit_level` check, `must_have_coverage` × `fit_level` contradiction check,
    reuse `findUnsupportedNumbers` as the numeric Layer-0 check.
  - Risk gate → conditional Layer 2 LLM call.
  - Failure classification + split-by-class action mapping.
- `submittal-fit.ts`: `runFitGeneration` returns `{ result, grade, meta }`;
  implement the single auto-regenerate on `hallucination`; remove the bare
  numeric `throw` in favor of the grade envelope (keep shape-validation throws).
- `index.ts`: read `SUBMITTAL_FIT_GRADER_MODEL`, inject grader AI client, return
  `grade` in the body.
- Tests: unit tests for each Layer 0 check; integ test (mocked deps) covering
  ship / structural-human_review / hallucination-retry-then-human_review paths.

### Phase 3 — Export-path guard

- Add a test against `prepare-submittal-template.ts` rendering asserting the
  output docx/XML contains no `internal_assessment` gap text, `fit_level`, or
  `must_have_coverage` content. No production code change expected.

### Phase 4 — Grader eval suite

- Add labeled grader fixtures + a promptfoo assertion (or a standalone harness
  alongside `scorecard.ts`) scoring `grade.action` against expected labels.
- Report precision/recall on `hard_fail`/`human_review`. Document the run
  command. Log (do not silently cap) any fixtures excluded.

## Edge Cases & Risk

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                                              |
| --------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Sycophantic generator marks everything `strong` to skip Layer 2 | M          | H      | Layer 0 `must_have_coverage` × `fit_level` contradiction forces Layer 2; grader eval measures it                        |
| Grader anchors on generator's stated gaps and rubber-stamps     | M          | M      | Prompt forces independent re-derivation of coverage _before_ seeing the generator's claim                               |
| Auto-regenerate loops / non-determinism                         | M          | M      | Hard cap of exactly one retry; second failure → `human_review`, never throw                                             |
| Internal gaps leak into client docx                             | L          | H      | No mustache tag for internal fields; Phase 3 test asserts absence                                                       |
| Grader latency/cost on every request                            | M          | M      | Conditional risk gate; cheap easy-path returns after Layer 0 only                                                       |
| Mis-calibrated gate (blocks everything / nothing) erodes trust  | M          | H      | Phase 4 labeled-fixture eval with precision/recall before enabling gating in portal                                     |
| Backwards-incompatible 422→200 change breaks a client           | L          | M      | Client-facing fields unchanged; documented; portal switches to `grade.action`                                           |
| Grader LLM call fails (network/timeout)                         | M          | M      | Treat grader error as `action: 'human_review'`, `failure_class: 'none'`, warning noted — fail safe, never silently ship |

## Acceptance Criteria

- [ ] `FitResult` + `FIT_RESULT_SCHEMA` extended with `jd_must_haves`,
      `must_have_coverage`, `fit_level` (enum), `internal_assessment`; strict,
      `additionalProperties: false`, no `unknown` types.
- [ ] System prompt extracts must-haves, scores coverage, and emits a rubric-based
      `fit_level`; can return non-`strong` levels.
- [ ] Layer 0 checks (banned-phrase × level, coverage × level, numeric grounding)
      are pure functions with unit tests.
- [ ] Layer 2 grader runs only when the risk gate trips; returns categorical
      `FitGrade` via strict `json_schema`; independently re-derives coverage.
- [ ] `hallucination` → one auto-regenerate then `human_review`; `structural` →
      `human_review` with no retry; clean → `ship`. Shape violations still 422.
- [ ] Grader LLM failure fails safe to `human_review`, never silent ship.
- [ ] 200 response includes `grade` + `assessment`; client-facing
      `fit_bullets`/`fit_summary`/`key_qualifications` unchanged.
- [ ] Export-path test asserts no internal/gap/fit_level content renders into the
      client docx.
- [ ] Grader eval suite with labeled fixtures (≥1 strong/ship, the existing
      scrum-master structural case, ≥1 hallucination) reports precision/recall.
- [ ] `fit-grader.ts` contains no `Deno.serve()` and is import-safe.
- [ ] New env var `SUBMITTAL_FIT_GRADER_MODEL` documented; no hardcoded secrets.
- [ ] ADR filed in `docs/adr/` for the grader + response-contract change.
- [ ] `pnpm typecheck`, `pnpm typecheck:functions`, `pnpm lint`, `pnpm format` pass.
- [ ] Unit + integ tests written and passing.
