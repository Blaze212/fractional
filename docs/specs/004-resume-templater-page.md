# Resume Templater Page

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-31

## Objective

The single member-facing page of the fractional portal: a logged-in user lands
here after login, optionally sets a company logo, pastes their resume text, clicks
**Generate**, watches a progress indicator, then sees a **summary** of the parsed
result and an **Export** button that downloads the branded `.docx`. This page is
the UI that ties together resume parsing (spec 001), the company logo (spec 002),
and auth (spec 003).

## Non-goals

- A separate settings page (logo upload lives inline on this page for now).
- File upload of the resume itself — resume input is **pasted text** (spec 001).
- Persisting the pasted text or the parsed result (stateless, per spec 001).
- Editing the parsed profile before export (read-only summary for v1).
- Any other portal pages (dashboard, history, etc.).

## Business Rationale

One screen that takes a resume in and produces a branded, formatted resume out is
the whole product surface for v1. Keeping it to a single page removes navigation
and settings overhead and gets the core value (paste → branded `.docx`) in front
of users fastest.

## Route & Entry

- Route: **`/resume-templater`** (protected).
- **Default post-login redirect** and the default authenticated landing route
  (replaces the placeholder `/` in spec 003).
- Unauthenticated access → redirect to `/login` (spec 003).

## Page Flow & States

Single page, four states:

1. **Idle (input)**
   - **Company logo uploader** (inline; spec 002): upload PNG/JPEG, preview the
     current logo, replace, remove. Optional — export works without it.
   - **Resume text area** with placeholder _"Paste resume here"_.
   - **Generate** button — disabled until the text area is non-empty.
2. **Generating (loading)**
   - On **Generate**: show a **progress bar + spinner** with the label
     _"Estimated completion: 60 seconds"_ (animated countdown/progress; see Notes).
   - Calls `resume-parse` (spec 001) with the pasted text.
   - Inputs disabled while in flight.
3. **Success (result)**
   - **Summary** of the parsed profile (read-only) — e.g. name, headline,
     seniority, years, key roles, skills (rendered from the `ParsedProfile`).
   - **Export** button → generates and downloads the branded `.docx`.
4. **Error**
   - Friendly message + **Try again** (re-enables the form, preserves the pasted
     text and logo).

```
[Idle] ──Generate──► [Generating: bar + spinner, "~60s"] ──► [Success: Summary + Export]
   ▲                                │                              │
   │                                └──error──► [Error: retry] ─────┘
   └────────────── logo upload / replace / remove (any time in Idle) ────────────
```

## How it wires the other specs

- **Logo (002):** the uploader calls the `resume-logo` `POST`/`GET`/`DELETE`
  endpoints. The current logo is shown as a preview.
- **Parse (001):** **Generate** sends the pasted text to `resume-parse` and
  receives the `ParsedProfile` used to render the summary.
- **Export (002, Phase 3):** **Export** runs the client-side
  PizZip + Docxtemplater render — template + `ParsedProfile` mapped to render
  data + the user's logo embedded at `{{%company_logo}}` — and triggers the
  download. No logo configured → exports with the tag empty.

## Notes / Decisions

- **The "60 seconds" is a UX estimate, not a hard timeout.** The single
  `gpt-5.4-mini` call is typically faster; the progress UI should approach but not
  complete at 60s, and snap to done when the response arrives. If the call exceeds
  the estimate, keep the spinner and show a "still working…" note rather than
  failing.
- **Generate vs Export are distinct actions:** Generate = parse (network/LLM);
  Export = local docx build (fast, no network beyond fetching the logo).
- **Summary is read-only** in v1 (no inline editing).

## Dependencies & Build Order

This page is the capstone; build the others first. Recommended order:

1. **003 — Auth + portal shell** (Vite/React/Router/Tailwind, plain Tailwind
   components, `AuthContext`, `ProtectedRoute`, login/reset). Establishes the app
   this page lives in.
2. **001 — `resume-parse` edge function** (backend, independent — can be built in
   parallel with 003).
3. **002 — logo storage + `resume-logo` function + export mapping** (needs the
   portal from 003; consumes the 001 schema).
4. **004 — this page**, wiring 001 (Generate), 002 (logo upload + Export), and
   003 (auth/landing) together.

## Implementation Phases

### Phase 1 — Page scaffold + states

- `/resume-templater` route (protected), wired as the post-login redirect.
- Idle/Generating/Success/Error state machine; text area + Generate button.
- Tests: state transitions, Generate disabled when empty, error→retry preserves
  input.

### Phase 2 — Parse integration + summary

- Call `resume-parse`; render the `ParsedProfile` summary.
- Progress bar + spinner with the ~60s estimate.
- Tests: mocked parse success/failure, summary rendering, progress display.

### Phase 3 — Logo uploader + export

- Inline logo uploader (consumes spec 002 endpoints).
- Export button → client-side docx with logo embedded.
- Tests: upload/preview/remove states; export with and without a logo.

## Edge Cases & Risk

| Risk                               | Likelihood | Impact | Mitigation                                                                    |
| ---------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------- |
| Parse slower than the 60s estimate | M          | L      | Estimate is soft; keep spinner + "still working…", don't fail at 60s          |
| Empty / junk pasted text           | M          | L      | Disable Generate when empty; surface 001's `400` as a friendly error          |
| Parse error / LLM failure          | M          | M      | Error state with retry; preserve pasted text + logo                           |
| Export clicked with no logo        | M          | L      | Tag renders empty; export still succeeds (spec 002)                           |
| User edits text after generating   | L          | L      | Changing input invalidates the summary → return to Idle / require re-generate |
| Double-click Generate              | L          | L      | Disable button while in flight                                                |

## Acceptance Criteria

- [ ] After login, the user lands on `/resume-templater`; it is protected.
- [ ] Page shows a logo uploader, a "Paste resume here" text area, and a Generate
      button (disabled when the text area is empty).
- [ ] Clicking Generate shows a progress bar + spinner labelled with a ~60s
      estimate and calls `resume-parse` with the pasted text.
- [ ] On success, a read-only summary of the parsed profile renders with an Export
      button.
- [ ] Export downloads a `.docx` built from the template + parsed profile, with
      the user's logo embedded at `{{%company_logo}}` (or empty if none set).
- [ ] Parse failure shows a friendly error with retry; pasted text + logo are
      preserved.
- [ ] No settings page exists; logo management is inline on this page.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass.
- [ ] Component tests cover all four states and the export path.
- [ ] ADR filed if warranted (page composition is likely covered by 001/002/003
      ADRs).

## Open Questions

1. **Summary content** — exact fields to show (full profile vs. a condensed
   header + counts). Defaulting to: name, seniority level, # of roles, top
   companies/titles, and skills (drawn from the spec 001 `ParsedProfile`).
2. **Logo placement on the page** — above the text area or in a side panel?
   (Cosmetic; resolve in design.)
