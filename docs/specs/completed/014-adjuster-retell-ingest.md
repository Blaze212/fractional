# Retell Ingest into Apps Script

**Status:** Implemented — completed 2026-08-31
**Owner:** Brandon Adjuster / Phase 0
**Last updated:** 2026-08-31

## Objective

Add Retell as a second voice platform feeding the existing `apps/adjuster`
Apps Script pipeline, alongside Dograh, with **zero behavior change to the
existing Dograh path**. A Retell call produces a `call_ended` webhook (audio +
inline transcript) followed by a `call_analyzed` webhook (post-call analysis +
extracted dynamic variables), routed through the same `webhook.js` /
`jobs.js` / `validate.js` pipeline that Telnyx and Dograh already use, so
matching, extraction, and doc generation need no Retell-specific branches.

Corresponds to Linear BH-41 (parent), BH-67–BH-75.

## Non-goals

- No changes to Telnyx or Dograh call handling behavior (guarded by a
  companion spec, 017, which pins Dograh's current behavior as a regression
  test — see Dependencies below).
- No UI/webapp changes (`apps/adjuster` has no `ui/` directory today; the
  planning doc that mentioned one does not match the current tree).
- No outbound calls to the Retell REST API (e.g. `getCall`/`listCalls`) —
  everything needed arrives inline in the two webhook payloads.
- Runner/extraction-stage feature work for Retell (e.g. deeper cross-check
  prompting) is out of scope beyond the minimal generalization needed to keep
  Dograh's existing extraction hint working after the field rename (Phase 3).
- No stale-job promotion job for `awaiting_analysis` / `awaiting_call_ended`
  (see Edge Cases — mirrors `promoteStaleAwaitingTranscript` but is left for
  a follow-up spec).

## Dependencies

Depends conceptually on spec 017 (Dograh regression guard) landing to confirm
no Dograh behavior changed. This spec does not block on 017 existing yet, but
either PR should note the other in review.

## Grounding notes (planning doc vs. reality)

The task brief that seeded this spec assumed some structure that doesn't
match the live code. Corrected here:

- **Apps Script cannot read HTTP request headers.** `doPost(e)` only exposes
  `e.parameter`, `e.postData`, `e.contentLength` — there is no
  `e.headers`/`e.request.headers` (confirmed: this is a long-standing,
  still-open Apps Script platform limitation, tracked publicly as Google
  Issue Tracker 67764685). Retell's `X-Retell-Signature` header therefore
  **cannot** be read directly inside `webhook.js`. The bh-systems Cloudflare
  Worker proxy (`apps/bh-systems/src/worker.js`), which already sits in front
  of every webhook call, is extended to read that header and forward its
  value through as a query parameter (`retell_sig`) on the proxied request.
  Apps Script then does the actual HMAC verification via
  `Utilities.computeHmacSha256Signature()`, per the task brief — the header
  just has to ride in on the query string instead of as a header, because of
  the platform limitation above.
- **Retell signs with the account's Retell API key, not a separate webhook
  secret.** Per Retell's docs
  (`https://docs.retellai.com/features/secure-webhook`), the header is
  `X-Retell-Signature: v={unix_ms_timestamp},d={hex_hmac_sha256_digest}`,
  computed as `HMAC-SHA256(raw_body + timestamp, api_key)` using an API key
  that has the "webhook" badge in the Retell dashboard. This repo stores that
  key as script property `RETELL_API_KEY`.
- **`dograh_validated` is currently write-only.** `handleDograhNotetaker`
  writes `dograh_validated` to the Jobs sheet, but nothing in the codebase
  reads it back — `runner.js`'s extraction stage reads `dograh_fields` (the
  raw export), re-derives everything via OpenRouter, and calls
  `validateFields()` on that result. `dograh_validated` is renamed alongside
  `dograh_fields` for consistency, but no downstream consumer depends on its
  shape today beyond the rename itself.
- **`apps/adjuster/src/validate.js` has no existing test coverage for
  `validateDograhFields`** — `validate.test.ts` only exercises
  `validateFields`/`applyCalendarFallback`. This spec adds the first tests
  for the renamed `validateLiveFields`, covering both sources.
- Retell's real webhook/call-object field names were confirmed against a live
  call via the Retell API (`listCalls`/`getCall`) rather than assumed:
  `call_id`, `start_timestamp`/`end_timestamp` (epoch ms),
  `duration_ms`, `transcript` (string), `transcript_object` (array of
  `{role, content, words: [{word, start, end}]}`), `recording_url`,
  `collected_dynamic_variables` (flat object — this is the "extracted
  dynamic variables" the task brief referred to), and `call_analysis`
  (`{call_summary, custom_analysis_data, user_sentiment, call_successful,
in_voicemail}` — this is what the task brief called
  `post_call_analysis_data`; the real field is `call_analysis`). The webhook
  body shape itself (`{event, call}`) is documented by Retell but not proven
  against a captured live webhook payload in this repo — flagged as an
  unconfirmed-against-a-live-call hedge, same pattern this file's
  `webhook.js` already uses for Telnyx and Dograh field names (see its
  top-of-file comment).
- Whether Retell's webhook delivery follows the 302 Apps Script `/exec`
  issues (`webhook.js`/the bh-systems Worker comment) is not confirmed either
  way from Retell's public docs. Per the task instructions, the Worker proxy
  is used regardless, for consistency with how Dograh and Telnyx are already
  routed — it removes the question entirely rather than depending on the
  answer.

## Architecture

### Request path

```
Retell agent webhook config
  → https://<bh-systems-worker-domain>/texml/gas?event=retell&t=<WEBHOOK_SECRET>
  → apps/bh-systems Worker (proxyToAppsScript):
      - forwards query string as-is (t=... already present)
      - reads X-Retell-Signature header, appends it as &retell_sig=... on the
        target query string
      - forwards the raw POST body untouched
      - follows the Apps Script /exec 302 server-side, returns one response
  → Apps Script /exec doPost(e)
      - e.parameter.t   → existing WEBHOOK_SECRET gate (kept, see below)
      - e.parameter.retell_sig → X-Retell-Signature value, verified in
        webhook.js via Utilities.computeHmacSha256Signature()
      - e.postData.contents → raw JSON body, {event, call}
```

### Two gates, deliberately kept both

The task explicitly asks us to decide whether the pre-existing `t=` shared
secret stays as a second gate alongside the new per-request HMAC signature.
**Decision: keep it.** Rationale:

- It is already the first line of `routeWebhook()` and applies uniformly to
  every event — removing it for one event type would mean special-casing the
  gate itself, more code and more risk than leaving it alone.
- It costs nothing extra: it's a static query param already baked into every
  other webhook URL this app exposes (Dograh's Notetaker export node,
  Telnyx's callback URLs).
- Defense in depth: if `RETELL_API_KEY` (used for HMAC verification) is ever
  rotated on the Retell side without being updated in Apps Script script
  properties, the `t=` gate still blocks unrelated internet traffic from
  reaching `handleRetellCallEnded`/`handleRetellCallAnalyzed` while the HMAC
  mismatch is being diagnosed.
- Reversible: if it turns out to cause operational friction (e.g. Retell
  webhook URL configuration doesn't support the query string cleanly), it's
  a one-line removal, not an architecture change.

### Namespacing

`capture_id` / `job` rows for Retell calls are keyed
`'retell-' + call.call_id` (Retell's own `call_id`s already look like
`call_ef89bbc984713ff092a32719f09`, so the result is
`retell-call_ef89bbc984713ff092a32719f09`). This can never collide with
`dograh-<workflow_run_id>` rows or raw Telnyx `CallSessionId` UUIDs, mirroring
exactly how `dograh-` namespacing already avoids Telnyx collisions today
(see `webhook.js`'s comment on `handleDograhNotetaker`).

### `live_fields` generalization

`apps/adjuster/src/validate.js`'s `validateDograhFields(dograhFields,
tagSchema)` becomes `validateLiveFields(rawFields, tagSchema, source)`. The
only functional change is that the hardcoded `confidence: 'dograh'` on a
valid field becomes `confidence: source` — called as
`validateLiveFields(body, tagSchema, 'dograh')` from the Dograh call site and
`validateLiveFields(dynamicVariables, tagSchema, 'retell')` from the new
Retell call site. Passing `'dograh'` reproduces byte-identical output to
today, so this is a pure parametrization, not a behavior change.

The Jobs sheet columns follow the same rename:

| Old column         | New column              |
| ------------------ | ----------------------- |
| `dograh_fields`    | `live_fields`           |
| `dograh_validated` | `live_fields_validated` |
| _(none)_           | `live_fields_source`    |
| _(none)_           | `call_analysis_data`    |

`live_fields_source` and `call_analysis_data` are new columns; `live_fields`
and `live_fields_validated` are renames of existing headers. **A production
Jobs sheet still has old `dograh_fields`/`dograh_validated` headers** —
`writeRowFields()` throws on any header it can't find (`jobs.js`,
`findColumnIndex`), so both the Dograh and Retell write paths call
`ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)` before their first `upsertJob`,
exactly the existing pattern `JOBS_TRANSCRIPTION_COLUMNS` already established
for the transcription columns. The old `dograh_fields`/`dograh_validated`
columns are left in place, unused — same "no migration" precedent
`copyRecordingToDrive`'s header comment already documents for the flat
recordings folder.

`runner.js`'s one read site (`job.dograh_fields`, feeding the OpenRouter
cross-check hint in `runExtractionStage`) is updated to read `job.live_fields`
and to gate on `job.source === 'dograh' || job.source === 'retell'` instead
of `job.source === 'dograh'` alone — otherwise renaming the column silently
breaks Dograh's existing live-extraction hint (`dograhFields` would always
parse to `{}`). This is the one mandatory non-additive change in this spec;
without it, "zero Dograh behavior change" is violated by the rename itself.

### Two-phase ingest and idempotent ordering

Retell fires `call_ended` (audio + transcript ready) and `call_analyzed`
(post-call analysis + dynamic variables ready) as two separate webhooks, not
guaranteed to arrive in order. Mirrors the existing `handleRecording`
/`handleTranscription` idiom in `webhook.js` (whichever of two independent
signals arrives second flips status to `pending`):

- `handleRetellCallEnded` sets status `pending` if the job already carries
  `call_analysis_data` (i.e. `call_analyzed` got there first), else
  `awaiting_analysis`.
- `handleRetellCallAnalyzed` sets status `pending` if the job already carries
  `call_ended_at` (i.e. `call_ended` got there first), else
  `awaiting_call_ended`.

Both handlers call `upsertJob`, which creates the row if it doesn't exist yet
(`jobs.js`) — so whichever webhook arrives first never crashes, it just
leaves the job in a partial, well-defined state for the second webhook to
complete.

### Drive artifacts

`handleRetellCallEnded` mirrors Dograh's job-shell creation
(`tryGetCallFolder`, `copyRecordingToDrive`, `writeCallArtifact`,
`writeManifest` — all already generic, reused as-is, not duplicated):

- Per-call Drive folder via `getOrCreateCallFolder`/`tryGetCallFolder`
  (same as Dograh).
- Recording copied to that folder via `copyRecordingToDrive` (same helper,
  `'wav'` fallback extension — same default Dograh uses, since Retell's
  actual container isn't documented either).
- `transcript-retell.txt` — the inline `call.transcript` string.
- `transcript-retell-words.json` — `call.transcript_object` verbatim (only
  written when present and non-empty), satisfying the per-word-timing
  requirement.
- `manifest.json` — same shape Dograh's `tryWriteCallArtifacts` writes,
  via the same `writeManifest`, for Drive-folder audit parity.

## Implementation Phases

### Phase 1 — `validateLiveFields` generalization

- `apps/adjuster/src/validate.js`: rename `validateDograhFields` →
  `validateLiveFields(rawFields, tagSchema, source)`; parametrize
  `confidence: 'dograh'` → `confidence: source`.
- `apps/adjuster/src/webhook.js`: update the two existing call sites
  (`handleDograhNotetaker`, `handleManualRecordingInject`) to call
  `validateLiveFields(body, tagSchema, 'dograh')` and write
  `live_fields`/`live_fields_validated`/`live_fields_source` instead of
  `dograh_fields`/`dograh_validated`. Add `JOBS_LIVE_FIELDS_COLUMNS` and
  `ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)` calls at both sites.
- `apps/adjuster/src/runner.js`: update the `job.dograh_fields` read site to
  `job.live_fields`, gate widened to `dograh`/`retell`.
- Tests: update `tests/unit/adjuster/webhook.test.ts` (`validateDograhFields`
  → `validateLiveFields` sandbox override) and
  `tests/unit/adjuster/runner.test.ts` (`dograh_fields` fixture →
  `live_fields`). Add `validateLiveFields` coverage to
  `tests/unit/adjuster/validate.test.ts` for both `'dograh'` and `'retell'`
  sources (enum/variant/omitted-field/confidence-stamp cases).

### Phase 2 — bh-systems Worker: forward the Retell signature header

- `apps/bh-systems/src/worker.js`: in `proxyToAppsScript`, read
  `request.headers.get('x-retell-signature')` and, when present, set it on
  `target.search` as `retell_sig` before forwarding. No change to Dograh/
  Telnyx behavior — the header is absent on those requests, so the query
  string is unchanged for them.

### Phase 3 — `webhook.js`: Retell routing, signature verification, ingest

- Add `event === 'retell'` branch in `routeWebhook()`, positioned alongside
  the other JSON-body event branches (`dograh_notetaker`,
  `dograh_pre_call`, `manual_recording_inject`) — i.e. before the Telnyx
  `CallSessionId` shape checks, same reasoning those branches already
  document.
- `verifyRetellSignature(retellSigParam, e)`: parses `v=...,d=...`, checks
  timestamp freshness (5 minute window, matching Retell's documented
  replay-attack guidance), recomputes
  `HMAC-SHA256(raw_body + timestamp, RETELL_API_KEY)` via
  `Utilities.computeHmacSha256Signature()`, hex-encodes it (byte values
  masked with `& 0xff`, same idiom `transcription.js`'s `readByte` already
  uses for Apps Script's signed-byte quirk), and compares against the
  header's digest with a constant-time-ish loop rather than `===`.
- `handleRetellCallEnded(captureId, call)` / `handleRetellCallAnalyzed(captureId, call)`
  per Architecture above.
- `retellCaptureId`, `retellStartIso`, `retellDurationSec`,
  `tryWriteRetellCallArtifacts` helper functions.
- New script property: `RETELL_API_KEY` (Retell dashboard API key with the
  webhook badge).
- Tests in `tests/unit/adjuster/webhook.test.ts`:
  - Missing `retell_sig` → denied `missing_retell_signature`.
  - Malformed `retell_sig` (no `v=`/`d=`) → denied
    `malformed_retell_signature`.
  - Wrong digest → denied `bad_retell_signature`.
  - Stale timestamp (older than 5 minutes) → denied
    `stale_retell_signature`.
  - Valid signature + `call_ended` then `call_analyzed` → job ends `pending`
    with transcript, audio, `live_fields`, `call_analysis_data` all present.
  - Valid signature + `call_analyzed` then `call_ended` (reverse order) →
    same end state, no crash at either step.
  - `capture_id` is `retell-<call_id>`, distinct from a `dograh-<same-id>`
    row.
  - `transcript-retell-words.json` written only when `transcript_object` is
    present.

## Edge Cases & Risk

| Risk                                                                                                         | Likelihood                         | Impact                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apps Script cannot read headers directly                                                                     | Certain (platform limitation)      | High if unaddressed                                          | Signature forwarded via query param by the Worker proxy (Phase 2); documented in Grounding notes                                                                                                                                                                                                                                                                                                                         |
| `RETELL_API_KEY` rotated in Retell dashboard without updating the Apps Script script property                | Low                                | Medium (all Retell webhooks denied)                          | `t=` gate still blocks unrelated traffic; `webhook.denied` log line with `bad_retell_signature` reason makes this diagnosable quickly, same as any other config drift in this app                                                                                                                                                                                                                                        |
| A job stuck in `awaiting_analysis` or `awaiting_call_ended` forever if the second webhook never arrives      | Low-Medium                         | Low (one job silently never reaches `pending`)               | Not solved in this spec — no analogous `promoteStaleAwaitingTranscript`-style sweep for these two statuses yet; flagged as a Non-goal, worth a small follow-up if it's observed in practice                                                                                                                                                                                                                              |
| Renaming `dograh_fields`/`dograh_validated` breaks Dograh if `ensureJobsColumns` is missed at any write site | Low (caught by tests)              | High (violates the "zero Dograh behavior change" constraint) | Both Dograh write sites explicitly call `ensureJobsColumns(JOBS_LIVE_FIELDS_COLUMNS)`; `runner.test.ts`'s "feeds the Dograh live export in as a cross-check hint, as before" test exercises the read side end-to-end                                                                                                                                                                                                     |
| Retell's real webhook body shape doesn't match what's inferred from the REST API's Call object               | Medium (documented as unconfirmed) | Medium (silent no-op ingest)                                 | `logServerOnly` raw-payload logging on the `retell` branch, same pattern `handleDograhNotetaker` uses for its own unconfirmed hedges; tighten once a real payload is observed, per this file's own top-of-file precedent                                                                                                                                                                                                 |
| Retell retries a webhook that already succeeded (at-least-once delivery)                                     | Medium                             | Low                                                          | Both handlers are naturally idempotent — re-running `handleRetellCallEnded`/`handleRetellCallAnalyzed` on the same `call_id` just re-upserts the same row with the same or fresher data; `writeCallArtifact`'s versioning (`nextArtifactName`) avoids clobbering a prior artifact but does mean a retry writes a second `transcript-retell-2.txt` rather than overwriting — acceptable, same behavior Dograh already has |

## Acceptance Criteria

- [ ] `apps/adjuster/src/validate.js` exports `validateLiveFields` (not
      `validateDograhFields`); confidence stamp equals the passed `source`.
- [ ] `apps/adjuster/src/webhook.js` has an `event === 'retell'` branch in
      `routeWebhook()`, ahead of the Telnyx `CallSessionId` checks.
- [ ] Requests missing or failing `x-retell-signature` verification are
      denied and never reach `upsertJob`.
- [ ] `t=` shared-secret gate still applies to Retell requests (unchanged
      first line of `routeWebhook`).
- [ ] `apps/bh-systems/src/worker.js` forwards `X-Retell-Signature` as
      `retell_sig` on the proxied query string; Dograh/Telnyx requests are
      unaffected (no header present, no behavior change).
- [ ] Retell job rows are keyed `retell-<call_id>`; no collision possible
      with `dograh-*` or Telnyx capture ids.
- [ ] `call_ended` creates the job shell: Drive folder, audio copy, inline
      transcript, status `awaiting_analysis` (or `pending` if
      `call_analyzed` already landed).
- [ ] `call_analyzed` enriches the job with `call_analysis_data` and
      `live_fields`/`live_fields_validated`, status `pending` (or
      `awaiting_call_ended` if `call_ended` hasn't landed yet).
- [ ] Both webhook orderings (`call_ended`→`call_analyzed` and the reverse)
      end in the same correct `pending` state with no thrown error.
- [ ] `transcript-retell-words.json` is written from `call.transcript_object`
      when present.
- [ ] Existing Dograh rows: `handleDograhNotetaker`/`handleManualRecordingInject`
      write to `live_fields`/`live_fields_validated`/`live_fields_source`
      (not the old column names), gated by `ensureJobsColumns`.
- [ ] `runner.js`'s live-extraction hint still works for Dograh after the
      rename (`runner.test.ts`'s existing "as before" test passes unchanged
      in behavior, updated only for the fixture field name).
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm lint` all
      pass.
- [ ] No hardcoded secrets; `RETELL_API_KEY` documented as a required script
      property, not committed anywhere.
