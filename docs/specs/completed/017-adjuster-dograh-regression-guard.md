# Adjuster Dograh Regression Guard

**Status:** Draft
**Owner:** Adjuster (Brandon)
**Last updated:** 2026-08-31

## Objective

Brandon's insurance-adjuster voice-agent product (`apps/adjuster/`) currently
runs on a single voice platform, Dograh, feeding a shared Apps Script
pipeline (`webhook.js` → `jobs.js` Jobs sheet → `transcription.js` /
`runner.js`). Phase 0 of the "add Retell as a second voice platform" effort
needs a regression safety net that pins down exactly what the Dograh path
does **today**, before any Retell code lands, so that later PRs (specs
014-016: Retell ingest, inbound hook, transcription layer) can be checked
against a known-good baseline instead of "it still seems to work."

This spec adds:

1. Contract tests that pin the exact payload shapes `routeWebhook()` accepts
   for `dograh_notetaker`, `dograh_pre_call`, and `manual_recording_inject`,
   and the exact Jobs-sheet row each one produces via `upsertJob()`.
2. A human-executable A/B call runbook (Dograh number vs. future Retell
   number, same script, diff the resulting drafts) plus a reusable
   field-by-field draft-diff script skeleton to run it against, since no live
   Retell calls exist yet.
3. A written, code-grounded confirmation that unbinding a Retell phone number
   from its agent requires no other code changes to roll back to Dograh-only
   — i.e. that nothing downstream of the webhook assumes exactly one voice
   platform in a way that would break if Retell's inbound traffic simply
   stopped.

## Non-goals

- No Retell code, credentials, or webhook route. Retell does not exist yet in
  this codebase; this spec only prepares the safety net for its arrival.
- No changes to `handleDograhNotetaker`, `handleDograhPreCall`,
  `handleManualRecordingInject`, `upsertJob`, or any other Dograh-path
  behavior. This is a test-and-documentation-only change; if a phase turns up
  a real Dograh-path bug, it gets filed separately rather than fixed here.
- No live A/B call is placed as part of this spec — Retell has no live number
  yet. The runbook and comparison script are written and unit-tested now,
  exercised for real once Retell ships.
- No changes to `guidedFlow.js`'s guided flow or the Telnyx recording /
  transcription / AIGather paths — those are Telnyx-native, not Dograh, and
  already covered by existing tests; out of scope here.

## Business Rationale

Retell is being added as a second voice platform feeding the exact same
downstream pipeline (Jobs sheet → transcription → extraction → doc
generation). Any regression introduced during that work would most likely
show up as a silent change to the Dograh path (e.g. a shared helper edited to
accommodate Retell that subtly changes what it writes for a Dograh call).
Landing this guard first, and merging it before the Retell PRs, means CI
already has an explicit, checked baseline for "Dograh behaves exactly as it
did pre-Retell" the moment those PRs open — catching a regression in the PR
that introduces it rather than after a real production Dograh call goes
sideways.

## Architecture

No production code changes. This is entirely test and documentation surface
area:

- `tests/unit/adjuster/webhook.test.ts` gains a new top-level
  `describe('Dograh regression contract — pre-Retell baseline')` block with
  fixture-payload tests that assert the **complete** resulting Jobs-sheet row
  (every field `upsertJob()` is called with) for each of the three events,
  rather than the `toMatchObject()` partial-shape assertions the file already
  uses elsewhere. A full-row assertion fails loudly on any field added,
  renamed, or dropped — exactly what a Retell-driven refactor of a shared
  helper could do by accident.
- `scripts/adjuster-compare-ab-drafts.mjs` (new): a zero-dependency script,
  matching the existing `scripts/adjuster-inject-test-job.mjs` and
  `scripts/stt-transcribe.mjs` convention (Node 20+, no repo imports, run
  directly). Exports pure, independently-testable functions
  (`diffJobRows`, `formatDiffReport`) plus a CLI entry point that reads two
  JSON exports of a Jobs-sheet row (one per platform) and prints a
  field-by-field diff. It does not talk to Retell or the Sheets API — there
  is nothing to call yet — it operates on two JSON files a human pastes the
  relevant Jobs-sheet row into (documented in the runbook).
- `tests/unit/adjuster-compare-ab-drafts.test.ts` (new): unit tests for the
  script's pure diff functions, following the `tests/unit/stt-transcribe.test.ts`
  pattern of importing named exports directly from the `.mjs` file.
- `apps/adjuster/docs/dograh-retell-ab-call-runbook.md` (new): the human
  runbook — read the same script to both numbers, pull both resulting Jobs
  rows, run them through the comparison script, and how to read the output.
- This spec file itself carries the written rollback-path confirmation (see
  "Rollback Path Confirmation" under Edge Cases & Risk below), grounded in
  the actual `job.source` checks in `transcription.js` and `runner.js`.

No schema, migration, edge-function, or shared-package (`packages/ui`)
impact — `apps/adjuster` is a standalone Apps Script codebase outside the
Supabase/portal stack. No new env vars. No ADR needed (test/doc-only change,
no architecture decision).

### Ground truth: what `routeWebhook()` actually does (verified against source)

Read directly from `apps/adjuster/src/webhook.js` on this branch:

- `dograh_notetaker` — JSON body in `e.postData.contents` (not
  `e.parameter`, since Apps Script only populates `e.parameter` from query
  strings and form-encoded bodies). Requires `body.capture_id`; denies
  `missing_capture_id` (400) otherwise. Routes to
  `handleDograhNotetaker(captureId, body)`.
- `dograh_pre_call` — JSON body shaped
  `{ event: 'call_inbound', call_inbound: { agent_id, from_number, to_number } }`.
  No capture_id required (call hasn't been assigned one yet); routes to
  `handleDograhPreCall()`, which **never throws** — a claims-lookup failure
  degrades to `{ initial_context: { has_claim_suggestion: false } }` rather
  than failing the call.
- `manual_recording_inject` — JSON body with `capture_id`, `transcript`,
  `audio_base64` all required (denies `missing_capture_id` /
  `missing_transcript` / `missing_audio`, each 400, in that check order).
  Routes to `handleManualRecordingInject(captureId, body)`.

All three sit behind the same `params.t !== WEBHOOK_SECRET` gate as every
other event (checked first, before any event-specific branching).

### Ground truth: what each handler writes to the Jobs sheet (verified against source)

`handleDograhNotetaker` → `upsertJob(captureId, {...})` writes: `source:
'dograh'`, `call_folder_id`, `call_disposition`, `duration_sec`,
`call_started_at`, `call_ended_at` (server clock at receipt),
`recording_url`, `audio_drive_id`, `transcript` (truncated to 45000 chars),
`transcript_source: 'dograh-notetaker'`, `transcript_chars`, `dograh_fields`
(raw body as JSON), `dograh_validated` (validated against
`loadEnums()`/`validateDograhFields()`), `status: 'pending'`. `upsertJob`
itself always adds `capture_id` and `updated_at` (and `created_at` on first
insert).

`handleManualRecordingInject` → same field set and `source: 'dograh'`, but
`transcript_source: 'manual-test-inject'`, `recording_url: ''` (nothing was
fetched, audio came in as `audio_base64`), and `dograh_fields`/
`dograh_validated` both `JSON.stringify({})` (no live Dograh export to
validate against a manual inject).

`handleDograhPreCall` writes nothing to the Jobs sheet — it only returns a
JSON response body (`{ initial_context: {...} }`) consumed live by Dograh's
Start Call node.

## Implementation Phases

### Phase 1 — Contract tests for the three Dograh-adjacent webhook events

- Add fixture payloads (inline consts, matching the file's existing style) for:
  - a `dograh_notetaker` call with a recording URL, a transcript URL, and a
    non-empty `dograh_fields` body.
  - a `dograh_pre_call` inbound-call event, both with and without a claim
    inside the suggestion window.
  - a `manual_recording_inject` call with transcript + base64 audio.
- For each, assert the **complete** resulting Jobs-sheet row via `toEqual`
  (not `toMatchObject`) against every non-dynamic field, with dynamic fields
  (`call_ended_at`, `updated_at`, `created_at`) asserted via
  `expect.any(String)` / ISO-format regex rather than omitted.
- For `dograh_pre_call`, assert the complete `initial_context` response body
  shape (all keys) for both the suggestion and no-suggestion cases, not just
  the individual fields the existing tests already check.
- Verify: `pnpm typecheck && pnpm vitest run tests/unit/adjuster/webhook.test.ts`.

### Phase 2 — A/B call runbook and comparison script skeleton

- Write `apps/adjuster/docs/dograh-retell-ab-call-runbook.md`: step-by-step
  procedure for a human to call both the Dograh number and (once it exists)
  the Retell number with the same script (reuse
  `apps/adjuster/template/sample-call-script.txt` /
  `interactive-call-script.txt`), pull each call's resulting Jobs-sheet row,
  export each as JSON, and run them through the new comparison script.
  Documents what a clean pass looks like (fields that are expected to differ,
  like `capture_id`/`source`/timestamps, vs. fields that should match, like
  the extracted claim data) and what to do on a mismatch.
- Write `scripts/adjuster-compare-ab-drafts.mjs`: exports `diffJobRows(a, b,
{ ignoreFields })` returning an array of `{ field, a, b, match }`, and
  `formatDiffReport(diff)` for a human-readable printout; CLI entry point
  reads two JSON files from argv and prints the report, non-zero exit code
  if any non-ignored field differs.
- Write `tests/unit/adjuster-compare-ab-drafts.test.ts` covering
  `diffJobRows`/`formatDiffReport` directly (no live sheet access needed).
- Verify: `pnpm typecheck && pnpm vitest run tests/unit/adjuster-compare-ab-drafts.test.ts`.

### Phase 3 — Rollback path confirmation (written, no code change)

- Document, in this spec's Edge Cases & Risk section below, the concrete
  code paths that make "unbind the Retell number, no other code changes"
  true today, so the claim is checked against source rather than assumed.
- No test changes in this phase — it's a documentation-only deliverable,
  captured in the spec itself per the task's instructions ("coordinate
  conceptually with the ingest work — you don't need the Retell code to
  exist yet, just confirm nothing in the current Dograh path assumes
  single-platform in a way that would break on rollback").

## Edge Cases & Risk

| Risk                                                                                                                                                                 | Likelihood  | Impact | Mitigation                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Retell-adding PR edits a shared helper (`upsertJob`, `withJobLock`, `copyRecordingToDrive`) in a way that changes Dograh's row shape                               | M           | H      | Phase 1's full-row `toEqual` contract tests fail on any field added/renamed/dropped, not just on the fields a partial `toMatchObject` happened to check |
| `dograh_pre_call`'s response shape drifts (e.g. a renamed `initial_context` key) and Dograh's Start Call node silently gets less context                             | L           | M      | Phase 1 asserts the complete `initial_context` shape, not just individual fields                                                                        |
| The A/B runbook can't be validated end-to-end before Retell exists                                                                                                   | H (certain) | L      | Documented explicitly as a Non-goal; the comparison script's pure diff logic is unit-tested now so it's ready the moment real rows exist to feed it     |
| Rollback claim turns out to be wrong once Retell ingest actually lands (e.g. a future PR adds a `job.source === 'retell'` check that isn't a safe no-op when absent) | M           | H      | Documented below with the exact lines it depends on, so a reviewer on the Retell PRs can check new code against this claim instead of re-deriving it    |

### Rollback Path Confirmation

Verified against source on this branch. The pipeline's only voice-platform
discrimination is `job.source`, checked with plain equality in exactly two
places downstream of the webhook:

- `apps/adjuster/src/transcription.js:823` —
  `if (job.source !== 'dograh') { ...skip master-transcript merge... }`
- `apps/adjuster/src/transcription.js:1003` —
  `source: job.source === 'dograh' ? 'dograh' : ''` (extraction-transcript resolution)
- `apps/adjuster/src/runner.js:188` — `var isDograh = job.source === 'dograh'`
  (gates whether Dograh's live-captured field export is fed into extraction
  as a cross-check hint)

Every one of these is a **loose equality check against the literal string
`'dograh'`**, not a switch/enum validated against a fixed set of known
platforms, and not a check that throws or errors on an unrecognized value.
Telnyx-native jobs already exercise the `!== 'dograh'` branch today (Telnyx's
`handleRecording`/`handleTranscription` never set `job.source` at all, so it
reads as `undefined`, which fails the equality check the same as any other
non-`'dograh'` value) — proving this fallback path is already live, not
theoretical.

Consequence for rollback: once Retell ingest exists, a Retell-sourced job
would presumably carry some `job.source` value other than `'dograh'` (the
exact value is the Retell ingest work's decision, out of scope here). If the
Retell phone number is unbound from its agent, no new Retell webhooks fire —
existing Retell-sourced rows already in the Jobs sheet simply continue
through the same `!== 'dograh'` branches they always did (same as a Telnyx
row today), and all new calls resume arriving as Dograh-sourced jobs through
the unchanged `dograh_notetaker`/`dograh_pre_call` routes. **Nothing in
`routeWebhook()`, `transcription.js`, or `runner.js` needs to change to roll
back** — the Dograh routes are untouched by Retell's addition (new `if`
branches in `routeWebhook()` for new Retell event names, not modifications
to the existing `dograh_notetaker`/`dograh_pre_call`/`manual_recording_inject`
branches), and the `job.source` checks degrade safely for any value that
isn't the literal string `'dograh'`.

This confirmation should be re-checked once the actual Retell ingest PR
(specs 014-016) lands, in case that work introduces a `job.source ===
'retell'` branch whose _absence_ (rather than its presence) breaks something
— e.g. a future helper that assumes `job.source` is always one of exactly
two known values. Nothing in the current codebase does that.

## Acceptance Criteria

- [ ] `tests/unit/adjuster/webhook.test.ts` has fixture-based contract tests
      asserting the complete Jobs-sheet row shape for `dograh_notetaker` and
      `manual_recording_inject`, and the complete response shape for
      `dograh_pre_call` (both suggestion and no-suggestion cases)
- [ ] `scripts/adjuster-compare-ab-drafts.mjs` exists with `diffJobRows` and
      `formatDiffReport` exported and a working CLI entry point
- [ ] `tests/unit/adjuster-compare-ab-drafts.test.ts` covers the diff script's
      pure functions
- [ ] `apps/adjuster/docs/dograh-retell-ab-call-runbook.md` documents the
      human A/B call procedure end to end, including how to invoke the
      comparison script
- [ ] Rollback path confirmation is written and grounded in real file/line
      references (see Edge Cases & Risk above)
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm lint` all pass
- [ ] No production code in `apps/adjuster/src/` is modified
- [ ] No hardcoded secrets
