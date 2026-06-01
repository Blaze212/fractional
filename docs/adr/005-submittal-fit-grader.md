# ADR 005 — Submittal-Fit Grader + Honest Self-Assessment

**Status:** Accepted  
**Date:** 2026-06-01  
**Owner:** CareerSystems / submittal-fit  
**Related spec:** docs/specs/007-submittal-fit-grader.md

---

## Context

The `submittal-fit` edge function generates candidate narratives for real hiring managers. Prior to this change it only asked "why does this candidate fit?" — producing over-praising output with no mechanism for surfacing gaps or catching hallucinations. Recruiters had to manually verify every narrative before sending.

Two risks were accumulating:
1. **Factual risk** — fabricated metrics, titles, or employers reach a hiring manager.
2. **Reputational risk** — over-praising a weak candidate undermines agency credibility.

---

## Decision

We add a two-layer grading system on top of the existing generator:

**Layer 0 — deterministic (always runs):**
- Banned-phrase × fit_level contradiction (e.g., "ideal fit" in a `weak` narrative)
- Coverage consistency check: `strong` claim with unmet must-haves forces escalation
- Numeric grounding recheck via `findUnsupportedNumbers`

**Layer 1 — generator self-assessment (same LLM call):**
- Generator extracts JD must-haves, scores coverage, emits `fit_level` + `internal_assessment.gaps`
- `fit_level` rubric: `strong` ≥80% must-haves met, `moderate` 1-2 gaps, `weak` multiple misses, `not_recommended` missing core requirements

**Layer 2 — conditional LLM grader (gpt-5.4, separate call):**
- Runs only when the risk gate trips: `fit_level != strong`, gaps present, or Layer 0 issues
- Independently re-derives must-have coverage before seeing the generator's claim
- Flags non-numeric hallucinations and under-reported gaps
- Returns `failure_class`: `hallucination` | `structural` | `none`

**Auto-regenerate on hallucination:**
- If the grader returns `hallucination`, the generator call is retried exactly once
- If the retry also fails, the response returns `grade.action = 'human_review'` rather than throwing

**Failure classification split:**
- `hallucination` (transient) → `action: 'regenerate'` → auto-retry once → `human_review` on second failure
- `structural` (weak fit, not retryable) → `action: 'human_review'` immediately
- `grader error` → fail safe to `human_review` with warning; never silently ship

---

## Backwards-Incompatible Change

The 200 response body gains two new top-level keys:
- `assessment` — internal recruiter-facing data (`fit_level`, `jd_must_haves`, `must_have_coverage`, `gaps`)
- `grade` — the gate result (`action`, `failure_class`, `issues`, `warnings`)

The existing keys (`fit_bullets`, `fit_summary`, `key_qualifications`) are **unchanged**. Existing portal consumers continue working without modification.

**Breaking change for clients relying on 422 for hallucination errors:** The previous behavior threw `UnprocessableEntityException` (422) for ungrounded numbers. That 422 is now replaced with a 200 carrying `grade.action = 'human_review'`. Any client using a 422 as a "blocked" signal must switch to checking `grade.action`.

---

## Alternatives Considered

**Always run the grader (no risk gate):** Doubles latency and cost on every request. Rejected — the risk gate routes the easy majority (clean strong fits) through Layer 0 only.

**Fold grader into the generator (one prompt):** The grader's value comes from independent re-derivation of coverage before seeing the generator's self-assessment. A single prompt cannot enforce this independence. Rejected.

**Throw on structural failures:** Throwing means recruiters see an opaque error with no narrative to work from. The grade envelope lets the portal surface both the narrative and the recruiter warning. Rejected.

---

## Consequences

- Generator latency unchanged for the easy path (strong fit, clean Layer 0).
- ~1 extra LLM call (gpt-5.4) on any risky submission; amortized cost is low.
- Internal gaps never reach the client docx — no mustache tags for internal fields; Phase 3 test enforces this.
- Grader precision/recall tracked via labeled eval fixtures (`tests/eval/grader-fixtures/`).
- `SUBMITTAL_FIT_GRADER_MODEL` env var controls grader model; Doppler-managed.
