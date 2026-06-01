# Agency Candidate Submittal (MVP)

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-31

## Objective

Reframe the jobseeker resume templater (specs 001–004) into an **agency-facing
candidate submittal tool**, as a **stateless single-user MVP**. The logged-in user
is a recruiter; they paste a candidate's resume, enter the target **client + role +
JD**, get an LLM-generated, **fact-grounded "Why this candidate for {{ClientName}}"**
narrative, edit it, and export an **agency-branded `.docx`** to send to the hiring
manager. The reusable engine from 001–004 stays unchanged (parse → `ParsedProfile`
→ branded Docxtemplater render, plus the existing per-user logo). The only new
backend is a single fit-generation function. **No multi-tenant model, no
persistence, no migrations** — this is the wedge install for one recruiter.

## Non-goals

- **No multi-tenancy.** No agencies/recruiter-org model, no `agency_id`, no
  team/seat management. The logged-in user is the only actor; their existing
  per-user logo is the firm's branding.
- **No persistence / no database changes.** No clients/roles/candidates/submittals
  tables, no migrations, no RLS work. Everything lives in the page session
  (stateless, per spec 001/004).
- **No submittal history** — nothing is saved between sessions.
- **No PDF export** — DOCX only.
- **No file-upload intake** — resume and JD are **pasted text**.
- **No VMS/ATS integration, no client login.** Export + manual send only.
- **No separate JD-extraction step** — the raw JD text is passed directly into the
  fit-generation prompt.

Everything above is the explicit **"later build"** if a firm wants it set up for
their organization (per-firm setup, saved clients/roles, history, team accounts).

## Business Rationale

The engine (parse → branded doc) is proven; the jobseeker buyer is weak, the
recruiting agency is strong — recruiters hand-craft submittals today, slowly and
inconsistently. "Every candidate we send a client looks professional and tailored
to _their_ role" is a clear, repeatable pain. Shipping this for one recruiter / one
role is the results-in-advance wedge for a broader fractional engagement. The
fit-narrative ("they actually read our JD") is the differentiator over a generic
formatted resume. Keeping it stateless and single-user means it ships fast and
carries no infra/tenancy overhead.

## Architecture

Stays within the existing stateless, single-user model. No tenancy, no DB.

### Reused unchanged

- **`resume-parse`** (spec 001) — pasted resume → `ParsedProfile`. The parsed
  result is held in page state, not persisted.
- **Per-user logo** (spec 002) — the existing `resume-logo` endpoints + the
  `{{%company_logo}}` embed mechanism. Conceptually "the firm's logo"; no change.
- **Client-side export** (spec 004) — PizZip + Docxtemplater render in the browser;
  fast, no LLM. Reused against the new submittal template.
- **Auth** (spec 003) — `withAuth()` (ES256), `verify_jwt = false`.

### New Edge Function (single responsibility)

- **`submittal-fit`** (new) — input
  `{ parsed_profile: ParsedProfile, jd_text: string, client_name: string, role_title: string }`;
  output `{ fit_bullets: { text: string; source_ref: string }[] (exactly 3), fit_summary: string }`.
  - `verify_jwt = false`; auth via `withAuth()`; child logger
    `logger.child({ userId })` created at the top of the handler and passed down.
  - Uses the shared `ai-client.ts` — OpenAI **Responses API**, `gpt-5.4-mini`,
    JSON-schema structured output, `UsageLoggingContext` (per the
    `ai-provider-usage` skill). No raw SDK.
  - Exposes its AI client through a `Deps` interface for testability.
  - Lives in its own file; no `Deno.serve()` imported by other functions
    (module-isolation rule).

### Anti-hallucination grounding (mandatory)

A submittal goes to a real client; a fabricated metric (e.g. an invented "$8M ARR")
is a reputational/legal liability. `submittal-fit` MUST:

- Use **only** facts present in `parsed_profile` (`selected_experience.achievements`,
  `skills`, `tools`, `industries`, `career_highlights`, etc.). No numbers,
  employers, or claims absent from the input.
- Return a `source_ref` per bullet (e.g. `selected_experience[2]` or
  `career_highlights[0]`) so the UI shows provenance and the recruiter can verify.
- Be paired with the **mandatory human-edit step** (below) — generation is a
  draft, never an auto-send.

### Frontend ownership

The portal page owns the recruiter workflow:

- Inputs: client name, role title (and optional req id / location / hiring manager
  — purely template merge fields, free text), pasted **JD**, pasted **resume**.
- **Generate** → `resume-parse` (resume) then `submittal-fit` (profile + JD +
  client/role).
- **Editable** fit bullets (with provenance) + fit summary + recruiter-entered
  comp/logistics + notes — all editable before export (reverses spec 004's
  read-only stance).
- **Export** → client-side Docxtemplater render of the new submittal template with
  the user's logo; triggers download.

### New submittal `.docx` template

Spec 004's template renders _resume_ sections; the submittal needs a **new master
shell** (one template — per-firm uniqueness comes from logo + merge fields, not N
templates) with:

- Client + Role block: `{{client_name}}`, `{{role_title}}`, `{{req_id}}`,
  `{{location}}`, `{{hiring_manager}}`
- Branding: `{{%company_logo}}` (reuses spec 002)
- Candidate Snapshot: name, seniority, top titles/companies (from `ParsedProfile`)
- `{{fit_summary}}`
- "Why {{candidate_name}} for {{client_name}}":
  `{{#fit_bullets}}{{text}}{{/fit_bullets}}`
- Key Qualifications / Recent Experience (shortened, from `ParsedProfile`)
- `{{comp_logistics}}`, `{{recruiter_notes}}`

### Shared package impact

- `@cs/ui` — extend existing form primitives for the inputs/editor; no one-offs.
- No diagnostic-app impact. No new npm deps beyond spec 004's (PizZip, Docxtemplater).

### Auth / env / ADR

- `withAuth()` only; no new webhook or service-role surface.
- No new secrets; OpenAI key already Doppler-managed via `ai-client.ts`.
- This changes the product framing and adds an LLM-trust-boundary feature, so
  **file an ADR** in `docs/adr/` covering the reframe + the grounding requirement.
  (No schema decision to record — there is no schema.)

## Implementation Phases

### Phase 1 — `submittal-fit` edge function

- New function with the grounding contract + `source_ref` + `Deps` injection.
- Unit + integ tests (mocked AI deps), including: exactly-3-bullets shape, and an
  assertion that the output contains no claim/number absent from the input profile.

### Phase 2 — Submittal page (inputs + generate + editor)

- Extend the templater page (or a sibling route) with client/role/JD/resume inputs.
- Wire Generate: `resume-parse` then `submittal-fit`; show progress.
- Editable fit bullets (with provenance), fit summary, comp/logistics, notes.
- Tests: state machine (idle/generating/success/error), Generate disabled until
  resume + JD + client + role present, editing fields, error→retry preserves input.

### Phase 3 — New template + export

- Add the new submittal `.docx` master template to the app assets.
- Export: client-side Docxtemplater render with the user's logo embedded; download.
- Tests: export with and without a logo; all merge fields populated; fit_bullets
  loop renders.

## Edge Cases & Risk

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                                        |
| --------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| LLM fabricates a metric/claim in the fit narrative              | M          | **H**  | Grounding prompt (only `parsed_profile` facts) + `source_ref` provenance + mandatory recruiter edit before export |
| JD pasted is junk / empty                                       | M          | L      | Disable Generate until JD + client + role present; friendly error                                                 |
| `parsed_profile` thin (sparse resume)                           | M          | M      | Fit-gen returns fewer/weaker honest bullets rather than inventing; recruiter edits                                |
| Export clicked with no logo                                     | M          | L      | `{{%company_logo}}` renders empty; export still succeeds (spec 002)                                               |
| Parse or fit-gen LLM failure                                    | M          | M      | Error state + retry; preserve all entered inputs                                                                  |
| Recruiter edits resume/JD after generating                      | L          | L      | Changing inputs invalidates the result → require re-generate                                                      |
| `submittal-fit` imported by another function via `Deno.serve()` | L          | M      | Keep shared logic in non-`Deno.serve` files (module-isolation rule)                                               |

## Acceptance Criteria

- [ ] **No migrations, no new tables, no RLS** introduced (stateless MVP).
- [ ] `submittal-fit` returns 200 with exactly 3 `fit_bullets` (each `text` +
      `source_ref`) and a 1-sentence `fit_summary`, using **only** facts present in
      the input `parsed_profile` (covered by a test asserting no out-of-input claim).
- [ ] `submittal-fit` uses the shared `ai-client.ts` (OpenAI Responses API,
      `gpt-5.4-mini`, `UsageLoggingContext`, `Deps` injection) — no raw SDK;
      `verify_jwt = false`; child logger `{ userId }`.
- [ ] Recruiter can enter client/role/JD, paste a resume, Generate, **edit** all
      fit/comp/notes fields, and export a branded `.docx`.
- [ ] Exported `.docx` uses the **new submittal template** with the user's logo at
      `{{%company_logo}}` (or empty if none) and all merge fields populated,
      including the `fit_bullets` loop.
- [ ] Parse/fit failures show a friendly error with retry; entered inputs preserved.
- [ ] `pnpm typecheck` (incl. `typecheck:functions`), `pnpm lint`, `pnpm format` pass.
- [ ] Unit + integ tests for `submittal-fit` (mocked AI deps); component tests for
      the page states, editor, and export path.
- [ ] ADR filed in `docs/adr/` covering the reframe + grounding rule.
- [ ] No hardcoded secrets; no `unknown` types.

## Open Questions

1. **Page vs. route** — extend the existing `/resume-templater` page in place, or
   add a sibling route and leave the old page? (Lean: reframe the existing page —
   it's the same engine, and there's no jobseeker tenant to preserve.)
2. **Template authoring** — hand-build one master submittal `.docx` shell for the
   wedge (logo swap only), confirmed? (Lean: yes, one master shell.)
3. **Comp & logistics source** — fully recruiter-entered free text, confirmed?
   (Lean: yes.)
