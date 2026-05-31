# Resume Parsing

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-31

## Objective

Add a stateless resume-parsing endpoint to the greenfield `fractional`
(fractional-executive matching) service. A caller submits raw resume **text**,
the service runs a single LLM call to structure it, and returns a typed JSON
profile **whose shape maps directly onto the resume DOCX template's merge fields**
(spec 002 export), plus a few fractional-specific fields for future matching.
Nothing is persisted. This reuses the LLM-structuring approach from the
CareerSystems `resume-parse-worker`, stripped of its queue/worker/DB machinery
and file-extraction step.

## Non-goals

- File ingestion (PDF/DOC/DOCX) and text extraction — input is plain text only
  for v1 (see Future Work).
- Persisting resumes, parsed output, or any PII (DB rows, storage, content logs).
- Matching, scoring, or ranking execs against roles (separate future spec).
- Batch / async processing or a job queue.
- A frontend paste UI (that's spec 004; this spec is the API only).

## Business Rationale

The resume-templater page (spec 004) needs structured resume data to (a) show a
summary and (b) populate the branded DOCX (spec 002 export). Parsing pasted text
into the template's exact field shape is the smallest backend that unblocks both,
with zero data-retention liability.

## Architecture

**Decision summary:** synchronous, stateless Supabase Edge Function that takes
raw text and returns structured JSON via one OpenAI Responses API call.

- **Runtime:** Supabase Edge Function (Deno), TypeScript — mirrors the
  CareerSystems stack so the structuring logic ports directly.
- **Function name:** `resume-parse` (single responsibility: text → structured
  JSON).
- **Request / response contract:**
  - `POST /functions/v1/resume-parse`
  - **Body (JSON):** `{ "resume_text": string }`
  - **Limits:** `resume_text` non-empty after trim; max length `60_000` chars
    (configurable via env) → reject oversized input with `400`.
  - **`200` body:** `{ "profile": ParsedProfile, "meta": { model, input_char_count } }`
  - **Errors:** `{ "error": { "code": string, "message": string } }`
    - `400` — missing/empty `resume_text`, or over the length limit.
    - `401` — missing/invalid auth.
    - `422` — LLM could not produce valid structured output.
    - `500` — unexpected error / LLM provider failure.
  - Errors and logs **never** echo resume content.
- **AI:** OpenAI **Responses API** with structured output (JSON schema) via the
  project's shared AI provider wrapper — never the raw SDK. Inject the client
  through a `Deps` interface for testability.
  - Model: `gpt-5.4-mini` (the "simpler" model), overridable via env.
  - System prompt: extract only what is present, never fabricate; normalize dates
    to `YYYY-MM` (or `"Present"` for current roles); split roles into
    `selected_experience` (most recent/relevant, with bullets) vs
    `other_experience` (brief); infer `seniority_level` / `functional_areas` from
    titles and content.
- **Auth model — RESOLVED:** registered in `config.toml` with `verify_jwt = false`
  (ES256 rule); auth handled in-function via shared **`withAuth()`** (an
  authenticated portal user — spec 004 calls this from the logged-in page).
- **Shared package impact:** none for v1.
- **Env vars (Doppler-managed):**
  - `OPENAI_API_KEY`
  - `RESUME_PARSE_MODEL` (default `gpt-5.4-mini`)
  - `RESUME_PARSE_MAX_CHARS` (default `60000`)

### Output schema (authoritative)

Aligned to the resume DOCX template's merge fields so spec 002's export mapping
is mechanical. Unknown/absent scalars are `null`; absent lists are `[]`. The
LLM must not fabricate.

```ts
interface ParsedProfile {
  // Header / contact (template: name, headerLine, and per-field hyperlinks)
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;

  // Summary (template splits into two paragraphs at export time)
  summary: string | null;

  // Career highlights (template: careerHighlights bullets)
  career_highlights: string[];

  // Primary roles, rendered with responsibilities + achievements
  selected_experience: SelectedExperience[];

  // Secondary roles, rendered as company/title/dates only
  other_experience: OtherExperience[];

  // Education + certifications (template merges these into one section)
  education: Education[];
  certifications: Certification[];

  // Template: skillsLine / toolsLine (comma-joined at export)
  skills: string[];
  tools: string[];

  // Fractional-specific — NOT on the template; for future exec matching
  seniority_level: string | null;   // e.g. "C-Level", "VP", "Director"
  functional_areas: string[];       // e.g. ["Finance", "Operations"]
  industries: string[];             // e.g. ["SaaS", "Fintech"]
}

interface SelectedExperience {
  company: string | null;
  title: string | null;
  start_date: string | null;        // "YYYY-MM"
  end_date: string | null;          // "YYYY-MM" | "Present" | null
  responsibilities: string[];
  achievements: string[];
}

interface OtherExperience {
  company: string | null;
  title: string | null;
  start_date: string | null;        // "YYYY-MM"
  end_date: string | null;          // "YYYY-MM" | "Present" | null
}

interface Education {
  institution: string | null;
  degree: string | null;
}

interface Certification {
  provider: string | null;
  certification: string | null;
}
```

Notes on the template mapping (handled in spec 002's export, not here):
- `headerLine` = `phone | email | location | linkedin_url` (joined at export).
- `sponsorship` is a fixed constant added at export — not parsed.
- `summary` is split into two paragraphs at export.
- Dates are formatted (e.g. `"Jan 2020 – Present"`) at export.
- `selected_experience` / `other_experience` and `education` + `certifications`
  feed the corresponding template loops/sections.

**ADR:** file one under `docs/adr/` — new feature/capability. Cover:
synchronous-vs-worker design, no-persistence decision, text-only input, model
choice, and the template-aligned schema (incl. the selected/other split).

## Implementation Phases

### Phase 1 — `resume-parse` edge function (only phase)

- **What changes:** new edge function `supabase/functions/resume-parse/`.
- **DB migrations:** none.
- **Edge Function changes:**
  - Request validation (presence, trim, max-length).
  - `withAuth()` wiring; register in `config.toml` with `verify_jwt = false`.
  - Child logger with `{ userId }` per project logging rule; metadata only.
  - Single Responses API call with JSON-schema structured output, client behind
    a `Deps` interface.
  - Response shaping + error mapping (`400` / `401` / `422` / `500`).
- **Frontend changes:** none (consumed by spec 004).
- **Tests required:** unit tests (see Acceptance Criteria); integ test deferred
  until a test harness exists in the repo.

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Empty / whitespace-only `resume_text` | M | L | Validate after trim → `400` before any LLM call |
| Oversized input inflating tokens/cost | M | M | Enforce `RESUME_PARSE_MAX_CHARS` → `400` |
| LLM returns malformed / non-schema output | L | M | Structured-output JSON schema + validation → `422` on failure |
| LLM fabricates fields not in source | M | M | Prompt forbids fabrication; nulls/empties for missing data |
| Bad selected/other split (all roles "selected") | M | L | Prompt caps detailed roles; rest → `other_experience` |
| PII leaking into logs / error bodies | L | H | Log metadata only; never include resume text in logs or errors |
| OpenAI provider outage / timeout | L | M | Map to `500` with generic message; set request timeout |

## Acceptance Criteria

- [ ] `POST /functions/v1/resume-parse` with `{ "resume_text": "..." }` returns
      `200` and a body conforming to the `ParsedProfile` schema (all template
      sections present, empty arrays where absent).
- [ ] Empty/whitespace `resume_text` returns `400`; over-limit input returns `400`.
- [ ] Invalid/missing auth returns `401`.
- [ ] Malformed LLM output returns `422`; provider failure returns `500`.
- [ ] No DB rows, storage objects, or resume content in logs — verified.
- [ ] Function registered in `config.toml` with `verify_jwt = false`; auth via
      `withAuth()`.
- [ ] OpenAI client used via shared wrapper + `Deps` injection (no raw SDK).
- [ ] Unit tests cover: validation, error mapping, response shaping, mocked LLM
      happy path (incl. the selected/other split) — and pass.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass.
- [ ] ADR filed in `docs/adr/`.
- [ ] No hardcoded secrets.

## Open Questions

1. **Model fallback:** is `gpt-5.4-mini` sufficient, or fall back to `gpt-5.4`
   on low-confidence extractions?
2. **Max length:** is `60_000` chars a reasonable cap for exec resumes?
3. **Selected vs other:** cap the number of detailed (`selected_experience`)
   roles (e.g. most recent 4–5), or let the LLM decide by relevance?

## Future Work (out of scope)

- File ingestion (PDF/DOCX) and text extraction feeding this same endpoint.
- Persist parsed profiles and link to exec records.
- Matching / scoring against fractional roles.
- Confidence scoring and human-review flagging.
