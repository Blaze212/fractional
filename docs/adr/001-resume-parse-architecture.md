# ADR 001: Resume Parse Architecture

**Date:** 2026-05-31
**Status:** Accepted

## Context

We need to parse raw resume text into a structured profile that maps onto the DOCX template's merge fields. The profile must support both the branded resume export (spec 002) and future fractional-exec matching.

## Decisions

### 1. Synchronous stateless design (no queue/worker)

**Decision:** Single synchronous Supabase Edge Function — request in, JSON out.

**Why:** The fractional portal serves one user at a time (not high-volume batch). A queue/worker would add latency, infrastructure complexity, and a DB dependency (job state). Statelessness also eliminates PII retention risk since no resume content is persisted.

**Trade-off:** A single gpt-5.4-mini call can take 10–45s for a long resume; the client shows a progress indicator (spec 004). If we move to higher volume, the design can be upgraded to async.

### 2. Text-only input for v1 (no file extraction)

**Decision:** `resume_text` is a plain string. PDF/DOCX parsing is out of scope for v1.

**Why:** File extraction requires a separate library (pdfjs, docx2txt) and adds complexity. The portal's paste UI covers the real-world workflow for this user base.

### 3. No persistence of parsed output or PII

**Decision:** The function returns the parsed profile and stores nothing.

**Why:** Storing resumes creates GDPR/CCPA liability and requires a retention policy. For v1, the caller (portal) holds the result in memory for the session. The matching feature (future spec) will persist profiles only when explicitly submitted.

### 4. gpt-5.4-mini as the default model

**Decision:** Use `gpt-5.4-mini` (overridable via `RESUME_PARSE_MODEL` env var).

**Why:** Resume structuring is well within gpt-5.4-mini's capability and the cost is significantly lower than gpt-5.4. The CLAUDE.md convention establishes these as the project's leading reasoning models.

### 5. OpenAI Responses API with JSON schema structured output

**Decision:** Use `.responses.create()` with `text.format.type = 'json_schema'`.

**Why:** Structured output guarantees valid JSON conforming to the schema, eliminating the need for output parsing/retries. The Responses API is the preferred API per project conventions.

### 6. Template-aligned output schema

**Decision:** The `ParsedProfile` schema maps directly to the DOCX template's merge fields.

**Why:** Eliminates a separate transformation step between parsing and export (spec 002). The `selected_experience` / `other_experience` split reflects the template's two experience sections. Fractional-specific fields (`seniority_level`, `functional_areas`, `industries`) are included for future matching but not rendered in the template.

### 7. Deps injection for testability

**Decision:** Business logic (`runParsing`) accepts a `Deps` interface with `aiClient`. The `index.ts` entry point wires the real client.

**Why:** Allows unit tests to mock the LLM without network calls, making tests fast and deterministic.

## Rejected Alternatives

- **Worker + queue:** Added significant complexity for no benefit at current volume.
- **Anthropic Claude:** OpenAI structured output is more mature and cheaper for structured extraction tasks.
- **Chat Completions API:** Responses API is the project's preferred API for new integrations.
