# ADR 004: Agency Candidate-Submittal Reframe + LLM Grounding

**Date:** 2026-05-31
**Status:** Accepted

## Context

Specs 001–004 built a jobseeker résumé templater (parse → `ParsedProfile` → branded
DOCX). The jobseeker buyer is weak; recruiting agencies are a stronger buyer who
hand-craft candidate submittals slowly and inconsistently. Spec 005 reframes the same
engine into an **agency candidate-submittal tool**: the logged-in recruiter pastes a
candidate résumé + a target client/role/JD, gets an LLM-generated, fact-grounded
"why this candidate for {{client}}" narrative, edits it, and exports a branded `.docx`.

This is shipped as a **stateless, single-user MVP** — the wedge install for one
recruiter — so there is **no schema decision to record** (see Decision 1).

## Decisions

### 1. No multi-tenancy, no persistence, no migrations

**Decision:** Keep the existing stateless, single-user model. No agency/seat model, no
`agency_id`, no clients/roles/candidates/submittals tables, no RLS work. Everything
lives in page session state. The recruiter's existing per-user logo (spec 002) is the
firm's branding.

**Why:** Ships fast with zero infra/tenancy overhead and carries no PII-retention
liability. Per-firm setup, saved clients/roles, submittal history, and team accounts are
the explicit "later build" if a firm wants it provisioned for their org.

**Trade-off:** Nothing is saved between sessions; editing inputs after generating
requires re-generating. Acceptable for a wedge that proves value before infra spend.

### 2. New single-responsibility edge function `submittal-fit`

**Decision:** Add one function: input `{ parsed_profile, jd_text, client_name,
role_title }`, output `{ fit_bullets: { text, source_ref }[] (exactly 3), fit_summary }`.
`verify_jwt = false`, auth via `withAuth()`, child logger `{ userId }`. It reuses the
shared `OpenAiResponsesClient` (Responses API, `gpt-5.4-mini`, JSON-schema structured
output) and exposes its AI client through a `Deps` interface for test injection. The raw
JD text is passed straight into the prompt — no separate JD-extraction step.

**Why:** Mirrors the proven `resume-parse` shape (one responsibility, one file, no
`Deno.serve()` imported elsewhere per the module-isolation rule). `resume-parse` stays
unchanged and is called first; `submittal-fit` is the only new backend surface.

> Note: the project skill `ai-provider-usage` references a `UsageLoggingContext` /
> `OpenAiChatClient` API. The shared `ai-client.ts` in this repo currently only exposes
> `OpenAiResponsesClient(model, log)`, so this function matches the real `resume-parse`
> pattern. If/when `UsageLoggingContext` lands, wire it through here.

### 3. Anti-hallucination grounding is mandatory (LLM trust boundary)

**Decision:** A submittal goes to a real client, so a fabricated metric/employer/claim
is a reputational/legal liability. `submittal-fit` MUST:

- Instruct the model (system prompt) to use **only** facts present in `parsed_profile`,
  and to attach a `source_ref` (`selected_experience[N]`, `career_highlights[N]`,
  `skills`, `tools`, `industries`, …) to every bullet so the UI shows provenance.
- Enforce a **deterministic post-generation guard** in code: exactly 3 bullets, a
  non-empty summary, and **no numeric token in the output that is absent from the input
  profile** (`findUnsupportedNumbers`). A violation throws `UnprocessableEntity` (422),
  surfacing as a friendly retry in the UI rather than silently shipping a fabricated
  figure.
- Pair generation with a **mandatory human-edit step**: every fit bullet, the summary,
  comp/logistics, and notes are editable before export. Generation is always a draft,
  never an auto-send.

**Why:** Prompt instructions alone are not a guarantee. The numeric guard makes the most
dangerous failure mode (invented `$8M ARR`-style figures) deterministically catchable and
unit-testable, and the human-edit step is the final backstop.

**Trade-off:** The numeric guard can occasionally reject an otherwise-fine generation if
the model phrases a legitimately-derived figure differently than the résumé; the recruiter
simply regenerates. We favour false-positive caution over shipping a fabricated number.

### 4. One master submittal template; client-side render

**Decision:** Add a single new `submittal-template.docx` master shell (built
programmatically by `scripts/prepare-submittal-template.ts`, mirroring
`prepare-template.ts`). Per-firm uniqueness comes from the logo + merge fields, not N
templates. Export is the existing client-side PizZip + Docxtemplater path (spec 004),
reusing the shared logo-injection helper (`docxLogo.ts`, extracted from `resumeExport.ts`
so résumé and submittal share one implementation). With no logo, the transparent
placeholder is retained so export still succeeds.

**Why:** Keeps export fast and LLM-free, avoids duplicate logo logic, and matches the
proven spec-004 mechanism. Comp & logistics and recruiter notes are fully
recruiter-entered free-text merge fields.

### 5. Reframe the existing page in place

**Decision:** Repurpose the `/resume-templater` page into the recruiter submittal
workflow (inputs → Generate → editable fit/comp/notes → Export) rather than adding a
sibling route. Generate is disabled until résumé + JD + client + role are present.

**Why:** It's the same engine and there is no jobseeker tenant to preserve, so one page
is simpler than maintaining two.

## Consequences

- No DB/RLS/migration footprint; the change is one new edge function + frontend + one
  template asset.
- The LLM trust boundary is explicit and tested (grounding guard + provenance + mandatory
  edit).
- The "later build" (tenancy, persistence, history, teams) is deferred to a future spec.
