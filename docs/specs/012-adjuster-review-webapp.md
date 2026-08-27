# Adjuster Review Web App

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-08-27

## Objective

Replace the adjuster's current review step — reading a generated Google Doc and
manually fixing every `[NEEDS INPUT: label — heard: "source_span"]` marker inline
— with a web page. The adjuster sees the drafted report broken into its existing
sections (Assignment, Mortgage, Origin, Coverage, Risk, Roof, Exterior, per
`templateData.js`'s `section` field), and for every field that needs a human
look, a side panel shows the field label and the quoted transcript text
(`source_span`) it was drafted from, with a check (accept — the value gets
written into the report) and an X (reject — leave it for manual entry). The
Google Doc stays the final artifact; this page is the approval step that
produces the decisions `generateDoc()` needs before it runs.

## Non-goals

- Audio playback of the underlying call. That is
  [013-adjuster-transcript-audio-playback.md](013-adjuster-transcript-audio-playback.md),
  which depends on this spec's UI shell.
- Replacing the Google Doc as the source of truth for the finished report, or
  rendering the report itself in the browser (WYSIWYG editing, rich text, etc.).
  The web page reviews _fields_, not document prose.
- Editing high-confidence fields that never generated a `source_span` review
  item — those already render correctly and aren't shown here.
- Multi-tenant support, billing, or anything beyond one adjuster/business using
  their own Google Drive, template, and job data. See
  [011-adjuster-mvp.md](011-adjuster-mvp.md) for the settled single-operator
  scope this extends.
- Migrating job/claim tracking off the existing Google Sheet
  (`jobs.js`'s `getJobsSpreadsheet`) — this spec adds a review layer alongside
  it, not a replacement.

## Business Rationale

011-adjuster-mvp.md deliberately shipped with "no UI" and inline
`[NEEDS INPUT: ...]` markers as the fastest path to a working draft. That
non-goal was correct for validating whether voice capture produces a usable
draft at all. It did. The remaining friction is now the review step itself:
finding every marker in a Google Doc, deciding what's actually being asked,
and typing the fix by hand. A side-by-side review screen — the question and
the exact words the adjuster said, one check away from being accepted — turns
that into a few seconds per field instead of a document hunt.

## Architecture

### Runtime bridge: Apps Script pipeline → Supabase-backed React app

The existing pipeline (`transcription.js`, `matcher.js`/`llmMatcher.js`,
`validate.js`, `docgen.js`) runs entirely in Google Apps Script, deployed via
`clasp` — a deliberate MVP decision (see 011's "Runtime is Google Apps
Script"), not something this spec revisits. The review web app, by contrast,
should follow this repo's normal stack per `.claude/CLAUDE.md`: Vite + React,
Supabase Postgres + Supabase Auth, deployed to Cloudflare Pages. That means
two runtimes need a contract between them:

1. **After `validateFields`/`validateDograhFields` produce the resolved field
   map** (today consumed directly by `resolveTagsForDoc` in `docgen.js`),
   Apps Script POSTs the review-eligible fields (exact predicate in Phase 1)
   — tag, label, section, `source_span`, confidence tier, current value if
   any — to a new Supabase Edge Function (`adjuster-review-ingest`), keyed by
   the job's `captureId`/claim id already used in the Jobs/Claims sheet. This
   uses `UrlFetchApp`, the same mechanism Apps Script already uses for its
   other outbound HTTP calls (Deepgram/ElevenLabs/OpenRouter). **Auth**: Apps
   Script has no Supabase user session to present, so this cannot use
   `withAuth()`. It authenticates with a Doppler-managed shared secret (a new
   `ADJUSTER_BRIDGE_SECRET`, sent as a header, checked by the Edge Function
   before any other processing) — see Auth below for why this must be a
   distinct value from `webhook.js`'s existing `WEBHOOK_SECRET`, not a reuse
   of it.
2. The Edge Function upserts into a new `adjuster_review_items` table
   (see Schema below). This table, not the Apps Script Sheet, is what the
   React app reads and writes.
3. The adjuster reviews in the browser; each accept/reject writes a decision
   back to that row via Supabase directly (RLS-scoped, no Edge Function needed
   for reads/writes the authenticated adjuster owns).
4. **Finalize**: once every review item for a job has a decision (or the
   adjuster explicitly finalizes with some left rejected/pending), the web app
   calls an Edge Function (`adjuster-review-finalize`), authenticated
   normally via `withAuth()` since this call originates from the adjuster's
   browser session — this is a real Supabase user, unlike step 1. That
   function POSTs the decision set back to the existing Apps Script web app
   endpoint. **Correction to an earlier draft of this spec**: `webhook.js`'s
   `doPost`/`routeWebhook()` does not route on an `action` field via a `case`
   switch — it routes via a sequence of `if (params.event === '...')` checks.
   Add `if (params.event === 'apply_review_decisions')` as a new branch. That
   branch needs the same `t`-param shared-secret check every other event goes
   through (the Edge Function sends `ADJUSTER_BRIDGE_SECRET` as `t`), and
   needs to skip `looksLikeTelnyxCallId(callSessionId)` the way
   `dograh_notetaker`/`manual_recording_inject` already do, since Dograh-
   sourced job ids (`dograh-<workflow_run_id>`) don't match that shape. The
   handler merges decisions into the field map and calls `generateDoc()`,
   same as today's automatic path, just gated on human approval instead of
   running unconditionally.

This keeps `docgen.js`/`validate.js`/`templateData.js` as the single source of
truth for tag schema and document generation — the web app is a review
surface on top, not a parallel implementation of doc assembly. Call out
explicitly: this bridge (steps 1 and 4) is new integration surface between two
runtimes with different deploy mechanisms (`clasp` vs. this repo's CI), and
warrants an ADR — including the `ADJUSTER_BRIDGE_SECRET` vs. `WEBHOOK_SECRET`
separation — once the two Edge Functions' payload shapes are settled.

### Schema

New table, `adjuster_review_items` (see `new-migration` skill for exact
migration conventions):

| column           | type                       | notes                                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | uuid, pk                   |                                                                                                                                                                                                                                                                                    |
| `user_id`        | uuid, not null             | references `auth.users(id)` — the owning adjuster; see RLS below                                                                                                                                                                                                                   |
| `job_id`         | text                       | Apps Script `captureId`, not a Supabase FK — the job record of truth stays the Sheet                                                                                                                                                                                               |
| `tag`            | text                       | matches `tagSchema` key from `templateData.js`                                                                                                                                                                                                                                     |
| `label`          | text                       |                                                                                                                                                                                                                                                                                    |
| `section`        | text                       | see note below — section names are sourced dynamically from `templateData.js`/`enums.json`, this list is illustrative, not exhaustive (e.g. `enums.json` also has Interior, Personal Property, Mitigation, Overhead & Profit, Salvage & Subrogation, Coinsurance as of 2026-08-27) |
| `source_span`    | text, nullable             | the "heard" quote — nullable because not every review item has one, see Phase 1                                                                                                                                                                                                    |
| `confidence`     | text                       | high / medium / low / dograh / calendar                                                                                                                                                                                                                                            |
| `status`         | text                       | `pending` / `accepted` / `rejected`, default `pending`                                                                                                                                                                                                                             |
| `resolved_value` | text, nullable             | value to inject on accept, defaults to `source_span`                                                                                                                                                                                                                               |
| `decided_by`     | uuid, nullable             | references `auth.users`                                                                                                                                                                                                                                                            |
| `decided_at`     | timestamptz, nullable      |                                                                                                                                                                                                                                                                                    |
| `created_at`     | timestamptz, default now() |                                                                                                                                                                                                                                                                                    |

Add `unique (job_id, tag)` — the ingest Edge Function's upsert (`ON CONFLICT`)
depends on this constraint existing; without it, upserts either silently
degrade to insert-only (duplicate rows accumulate on re-ingest) or need a
manual select-then-write that reintroduces the race a constraint prevents.

RLS: scope every policy on `auth.uid() = user_id` from the start, matching
every other RLS'd table in this repo (`user_agency_configs`,
`usage_limits`, `ai_usage_log`). At single-operator scope this is free — one
adjuster, one `user_id` value — and avoids a schema migration + backfill
later if a second user is ever added. Do not ship an interim "any
authenticated user can read/write any row" policy: with only `job_id` (not a
Supabase FK) on the table, there is no column such a policy could later be
tightened against without a migration.

### Frontend

New Vite app or route (follow `apps/portal`'s pattern — Supabase auth,
React Router). Page structure:

- Section list/tabs (Assignment, Mortgage, Origin, Coverage, Risk, Roof,
  Exterior) sourced from `adjuster_review_items.section`, only sections with
  at least one review item are shown.
- Main pane: read-only rendering of the section's resolved copy for context
  (the same tag → value resolution `resolveTagsForDoc` does, reimplemented
  client-side against the fetched review items — no need to fetch the
  Google Doc itself).
- Right rail: one card per pending/medium-confidence item in the active
  section — label, quoted `source_span`, check/X buttons.
- Section shows "done" once every item in it has a non-pending status.
- A finalize action, enabled once all sections are done (or explicitly
  overridable, per adjuster judgment — reject-and-finalize should be allowed,
  it just means that field stays `[NEEDS INPUT]` in the final doc).

Follow `.claude/skills/frontend-design/SKILL.md` for CareerSystems visual
conventions (colors, typography, components).

### Auth

Two distinct mechanisms, not one:

- **Adjuster login (browser → Supabase)**: Supabase Auth, per
  `.claude/skills/edge-function-env-pattern/SKILL.md` and this repo's
  existing `withAuth()` pattern. Applies to direct browser reads/writes on
  `adjuster_review_items` and to `adjuster-review-finalize` (called from the
  browser with a real user session). Single adjuster/business scope — no
  roles needed yet, just an authenticated user.
- **Apps Script → Supabase machine auth (`adjuster-review-ingest`)**: no
  Supabase user session exists on the Apps Script side, so `withAuth()`
  does not apply here. Use a Doppler-managed shared secret
  (`ADJUSTER_BRIDGE_SECRET`) sent as a header and checked before any other
  processing — the same shape as Apps Script's existing inbound `?t=SECRET`
  check in `webhook.js`, just in the opposite direction. This must be a
  distinct secret from `webhook.js`'s existing `WEBHOOK_SECRET`: reusing it
  would mean a leak of the (lower-stakes, per 011) webhook secret also grants
  the ability to write fabricated review decisions that get merged into the
  final Google Doc.

## Implementation Phases

### Phase 1 — Schema and ingest path

- Migration: `adjuster_review_items` table + RLS policies.
- `adjuster-review-ingest` Edge Function: accepts the field map from Apps
  Script, authenticates via `ADJUSTER_BRIDGE_SECRET` (see Auth), upserts rows
  keyed on the new `unique (job_id, tag)` constraint.
- Apps Script change: after `validateFields`/`validateDograhFields`, POST
  every field where `!field.valid || field.confidence === 'medium'` — this is
  `docgen.js`'s actual highlighting predicate (`resolveTagsForDoc`,
  `highlightNeedsInput`/`highlightMediumConfidence`). This is **not** "has a
  `source_span`": three of `validate.js`'s four `needsInput()` call sites
  (missing field, span not found in transcript, invalid enum/variant value)
  produce no `source_span` at all — only the low-confidence-with-real-span
  case does. Filtering on `source_span` presence would silently drop the most
  common `[NEEDS INPUT]` case (a field the adjuster never mentioned) from the
  review UI, defeating this spec's purpose. The review card for an item with
  no `source_span` simply omits the quoted-text section.
- Unit tests: Edge Function request/response contract, including secret
  rejection; Apps Script payload builder (pure function, testable per 011's
  "pure logic still gets unit tests" precedent). See
  `.claude/skills/integ-test-edge-function/SKILL.md` for where the Edge
  Function's own tests live relative to `tests/integ`.

### Phase 2 — Review UI

- New Vite app/route: section list, main pane, right rail, check/X actions
  writing directly to Supabase.
- Unit tests: section grouping, accept/reject state transitions, "section
  done" computation.

### Phase 3 — Finalize path

- `adjuster-review-finalize` Edge Function: authenticated via `withAuth()`
  (real adjuster session), reads all decisions for a job, POSTs to Apps
  Script's `doPost` with `event: 'apply_review_decisions'` and
  `t: ADJUSTER_BRIDGE_SECRET`.
- Apps Script change: `webhook.js`'s `routeWebhook()` gains a new
  `if (params.event === 'apply_review_decisions')` branch (matching its
  existing `if`-based routing, not a `case` switch), including the shared
  `t`-secret check and the `looksLikeTelnyxCallId` bypass Dograh-sourced
  events already need. `docgen.js`'s `resolveTagsForDoc` accepts an optional
  decisions overlay so accepted values replace what validation alone
  produced.
- Unit tests: decision-merge logic in `resolveTagsForDoc`; the new
  `routeWebhook()` branch's auth and call-ID-shape handling.

Each phase is independently useful to verify (ingest can be tested by
inspecting the table before any UI exists; the UI can be built against
seeded/manually-inserted rows before the finalize path exists), though the
feature isn't usable end-to-end until Phase 3 lands.

## Edge Cases & Risk

| Risk                                                                                                                                                    | Likelihood       | Impact | Mitigation                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps Script POST to Supabase fails/times out (network, Supabase downtime)                                                                               | M                | M      | Apps Script logs the failure (existing `log.js` pattern) and the job stays in its current status; doc generation falls back to the existing unconditional path so a review-ingest failure never blocks a draft from existing at all |
| Adjuster finalizes with items still pending                                                                                                             | H (expected use) | L      | Explicit UI confirmation; pending/rejected items render as `[NEEDS INPUT]` same as today, no silent data loss                                                                                                                       |
| Two review sessions open for the same job (adjuster on two tabs/devices)                                                                                | L                | M      | Last-write-wins on `status`/`decided_at` is acceptable at single-user scope; note as a known gap, not solved here                                                                                                                   |
| `source_span` text used for `resolved_value` doesn't match what the adjuster actually wants injected (e.g. needs light editing, not just accept/reject) | M                | M      | Out of scope for v1 — accept injects `source_span` verbatim; if this proves too rigid in practice, a follow-up spec can add inline editing of `resolved_value`                                                                      |
| Apps Script and Supabase schema drift (a `tagSchema` field renamed/removed without updating ingest)                                                     | M                | M      | Ingest function validates incoming tags against a known set (or just stores unknown tags — flag but don't fail) rather than hard-failing the whole payload                                                                          |
| `ADJUSTER_BRIDGE_SECRET` leaked or brute-forced                                                                                                         | L                | H      | Distinct value from `WEBHOOK_SECRET` (never reused), Doppler-managed, rotatable independently; a leak only grants write access to review-decision ingest/finalize, not the broader webhook surface                                  |

## Acceptance Criteria

- [ ] Migration for `adjuster_review_items` (including `user_id` and
      `unique (job_id, tag)`) applied and tested locally, RLS policies scoped
      on `auth.uid() = user_id` and verified — no interim "any authenticated
      user" policy shipped
- [ ] `adjuster-review-ingest` Edge Function rejects requests without a valid
      `ADJUSTER_BRIDGE_SECRET`, and upserts correctly on `(job_id, tag)`
- [ ] Apps Script POSTs every field where `!field.valid || field.confidence
    === 'medium'` after validation (not filtered on `source_span`
      presence), without blocking or breaking the existing unconditional
      `generateDoc()` path if the POST fails
- [ ] Review UI renders sections, shows pending items with label + quoted
      `source_span` when present, accept/reject writes back to Supabase
- [ ] Section shows "done" once all its items are non-pending
- [ ] `adjuster-review-finalize` requires a real adjuster session
      (`withAuth()`), then POSTs decisions to `webhook.js`'s `routeWebhook()`
      with `event: 'apply_review_decisions'` and the bridge secret as `t`,
      which merges them into `resolveTagsForDoc` and produces the same
      Google Doc output as today, minus the fields the adjuster accepted
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass
- [ ] Unit tests written and passing for: ingest contract (incl. auth
      rejection), decision-merge logic, section/done-state computation, the
      new `routeWebhook()` branch
- [ ] ADR filed in `docs/adr/` for the Apps Script ↔ Supabase bridge,
      including the `ADJUSTER_BRIDGE_SECRET`/`WEBHOOK_SECRET` separation
- [ ] No hardcoded secrets — `ADJUSTER_BRIDGE_SECRET` is Doppler-managed on
      the Supabase side and Script Properties-managed on the Apps Script
      side, and is a distinct value from `WEBHOOK_SECRET`
