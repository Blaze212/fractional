# Retell Reconciliation Sweep: Recover Calls the Webhooks Never Delivered

**Status:** Draft
**Owner:** Barton
**Last updated:** 2026-09-12

## Objective

Add a scheduled `event=retell_reconcile` route that queries Retell's
`POST /v3/list-calls` for recent calls, diffs the result against the Jobs
sheet, and repairs two classes of gap by replaying the authoritative call
record through the existing ingest handlers: calls with no row at all (both
webhooks lost) and calls parked at `awaiting_analysis` or
`awaiting_call_ended` (one of the two webhooks lost). This makes the webhook
a latency optimization rather than the only path into the pipeline, and closes
the stale-job gap `docs/specs/completed/014-adjuster-retell-ingest.md` recorded
as a deferred non-goal.

## Non-goals

- **Replacing the webhook.** Retell's webhooks stay the primary ingest path.
  This sweep is a backstop that runs behind them.
- **Moving Retell's webhook to n8n.** Spec 024 deliberately keeps n8n out of
  the ingest path. This spec makes that position cheaper to hold, it does not
  reverse it.
- **Reconciling Dograh calls.** Dograh's Notetaker has no equivalent list API
  wired up here. Retell only.
- **Repairing jobs already past ingest.** A job at `failed`, `done`, or any
  in-flight pipeline status is spec 024's problem (lease + reclaim), not this
  one. This sweep only fills in missing ingest.
- **`rerunCallAnalysis`.** It incurs charges and regenerates analysis rather
  than retrieving what Retell already has. Only used if Phase 0 shows
  `get-call` does not return analysis data (see Architecture).
- **Backfilling calls older than the configured window.** A one-off historical
  import, if ever needed, is a manual script, not this scheduled sweep.
- **Alerting on Retell-side call failures.** A call that genuinely never
  happened is not a gap.

## Business Rationale

Retell offers **3 webhook retries with a 10-second timeout** and publishes no
backoff interval, no delivery log, and no replay mechanism. All 17 call
endpoints were enumerated: there is no resend, redeliver, or event-history
endpoint. Once those three attempts are spent, a missed webhook is
unrecoverable through Retell's own tooling.

What Retell does give you is durable storage of the call itself.
`POST /v3/list-calls` supports a `start_timestamp` filter with `ge`/`le`
operators plus cursor pagination, and `GET /v2/get-call/{call_id}` returns the
full record. The data is never actually lost. It just has to be pulled rather
than pushed.

Two concrete failure modes this closes:

1. **Half-delivered pairs.** A Retell job reaches `pending` only when both
   `call_ended` and `call_analyzed` have landed; each handler checks for the
   other's marker (`webhook.js:473`, `webhook.js:500`). If one fails all its
   retries, the job parks at `awaiting_analysis` or `awaiting_call_ended`.
   Neither status appears in `reclaimStuckJobs`'s leased list (`jobs.js:262`),
   so nothing ever returns it to `pending`. It stalls forever with no error, no
   alert, and a row in the sheet that looks superficially fine. This needs only
   _one_ of two webhooks to fail, which makes it the more probable of the two
   gaps.

2. **Total loss.** The Worker is down, Apps Script is cold-starting past
   Retell's 10-second timeout, the trigger quota is exhausted, or the network
   drops. No row is created and there is no artifact anywhere to indicate a
   call happened.

Both currently end the same way: Brandon completes a site visit, no draft
appears, and nobody finds out until he asks. The report describes a visit that
cannot be repeated, so re-running the input is not an option.

## Architecture

### Placement: Apps Script, not n8n

The sweep runs inside Apps Script and is merely _triggered_ by n8n.

- `RETELL_API_KEY` already exists in Script Properties (`webhook.js:357`).
  No new secret, in n8n or anywhere else.
- The Jobs sheet is already local to the script. An n8n-side implementation
  would need Google Sheets credentials in n8n, or a new "list known capture_ids"
  endpoint to diff against.
- Durability should not depend on the component whose downtime it exists to
  survive. n8n being down delays the sweep; Retell holds the data until it
  runs, so a late sweep still repairs correctly.

### Separate endpoint from the drain

`event=retell_reconcile` is its own route with its own n8n schedule, not folded
into spec 024's `event=runner_drain`. Per `.claude/CLAUDE.md`, functions have
one responsibility. It also keeps the two independently tunable and
independently observable, and stops a slow reconcile from eating the drain's
wall-clock budget.

```
n8n Schedule Trigger (hourly)
   └─▶ HTTP Request ──▶ Worker /texml/gas?t=…&event=retell_reconcile
       └─▶ IF $json.ok === true, else alert
```

The n8n workflow is the same four-node shape spec 024 establishes, including
the requirement to assert on the response body rather than the HTTP status,
because the Worker returns 200 on proxy failure (`worker.js:52`).

### The sweep

1. `POST /v3/list-calls` with `filter_criteria`:
   - `start_timestamp: { type: "number", op: "ge", value: now - windowMs }`
   - `call_status: { type: "enum", op: "in", value: ["ended"] }`
   - `duration_ms: { type: "number", op: "ge", value: floorMs }`

   Window defaults to 24 hours via `RETELL_RECONCILE_WINDOW_HOURS`. The
   duration floor defaults to 30 seconds via `RETELL_RECONCILE_MIN_DURATION_SEC`
   and exists to keep misdials and hangups out of the sheet.

2. Read the Jobs sheet once. Build a map of `capture_id` to
   `{ status, call_ended_at, call_analysis_data }`.

3. For each returned call, compute `capture_id` as `'retell-' + call_id`
   (identical to `webhook.js:100`) and classify:

   | Sheet state           | Missing half | Action                                                  |
   | --------------------- | ------------ | ------------------------------------------------------- |
   | No row                | both         | `handleRetellCallEnded` then `handleRetellCallAnalyzed` |
   | `awaiting_analysis`   | analyzed     | `handleRetellCallAnalyzed` only                         |
   | `awaiting_call_ended` | ended        | `handleRetellCallEnded` only                            |
   | Any other status      | none         | skip                                                    |

   Targeting the missing half precisely matters for cost:
   `handleRetellCallEnded` calls `copyRecordingToDrive`, which downloads the
   recording and writes it to Drive. Re-running it on a job that already has
   `audio_drive_id` would duplicate that work for nothing.

4. Repair, bounded by `RETELL_RECONCILE_MAX_REPAIRS` (default 5) per run.
   Anything beyond the cap is left for the next hourly run and reported in the
   response so a backlog is visible rather than silent.

### Reusing the existing handlers

`handleRetellCallEnded(captureId, call)` and
`handleRetellCallAnalyzed(captureId, call)` both take a plain `call` object and
nothing else. The sweep calls them directly with the record pulled from the
API. No refactor, no duplicated ingest logic, and repair produces byte-identical
rows to the webhook path.

Signature verification is correctly bypassed: `verifyRetellSignature` exists to
authenticate an untrusted inbound POST. This data came from an authenticated
outbound pull against Retell's API using our own key, which is a stronger
guarantee, not a weaker one.

Both handlers already take `withJobLock`, so they interleave safely with live
webhooks and with spec 024's drain.

### Idempotency

`upsertJob` keys on `capture_id` (`jobs.js:96`), so a repair that races a
late-arriving webhook retry updates the same row rather than duplicating it.
This is the same property that already makes Retell's own duplicate deliveries
harmless.

### Response contract

```json
{
  "ok": true,
  "sweep_id": "reconcile-1757692800000",
  "window_hours": 24,
  "calls_examined": 12,
  "gaps_found": 2,
  "repaired": [
    { "capture_id": "retell-abc123", "was": "missing", "repaired": ["ended", "analyzed"] },
    { "capture_id": "retell-def456", "was": "awaiting_analysis", "repaired": ["analyzed"] }
  ],
  "deferred": 0,
  "ms": 8421
}
```

`gaps_found > 0` is the signal worth alerting on beyond `ok === false`: it means
the webhook path dropped something, which is worth knowing even though the
sweep fixed it.

### New Script Properties

| Key                                 | Default | Purpose              |
| ----------------------------------- | ------- | -------------------- |
| `RETELL_RECONCILE_WINDOW_HOURS`     | `24`    | How far back to look |
| `RETELL_RECONCILE_MIN_DURATION_SEC` | `30`    | Misdial floor        |
| `RETELL_RECONCILE_MAX_REPAIRS`      | `5`     | Per-run repair cap   |

All read via the existing `getOptionalConfig` (`config.js:7`) so the sweep runs
on defaults with nothing configured. `RETELL_API_KEY` is reused as-is.

### ADR

No new ADR. This adds a recovery path inside the architecture ADR 006 and
ADR 008 already describe, and introduces no new external dependency (Retell's
API is already a dependency; only the direction of the call is new). Spec 024's
ADR should gain a sentence noting that this sweep is what makes n8n's
absence from the ingest path safe.

## Implementation Phases

### Phase 0 — Verify the API contract

Load-bearing and cheap. If `get-call`/`list-calls` do not return analysis data,
the `awaiting_call_ended` repair path needs a different mechanism and the design
changes.

- Confirm `POST /v3/list-calls` returns full call objects rather than summaries.
  If summaries, the sweep adds a `GET /v2/get-call/{call_id}` per gap, which is
  a bounded extra cost, not a redesign.
- **Confirm the returned object carries `collected_dynamic_variables` and
  `call_analysis`.** `handleRetellCallAnalyzed` reads both
  (`webhook.js:491`, `webhook.js:499`). If they are absent from the API
  response and exist only in the webhook payload, repairing the analyzed half
  requires `rerunCallAnalysis`, which incurs charges, and that trade needs a
  decision before Phase 1.
- Confirm `transcript` and `recording_url` are present for
  `handleRetellCallEnded`.
- No code changes.

### Phase 1 — Sweep logic and route

- Add `apps/adjuster/src/reconcile.js` with `reconcileRetellCalls()`.
- Add a `retellListCalls(windowHours, minDurationSec)` helper using
  `UrlFetchApp` with the existing `RETELL_API_KEY` as a bearer token.
- Add `event=retell_reconcile` to `routeWebhook()` after the shared-secret gate.
- Log `retell_reconcile.started`, `.gap_found`, `.repaired`, `.deferred`,
  `.finished` through the existing `logEvent`, matching the one-terminal-line
  contract in `webhook.js`.
- **Tests:** the classification step is pure and gets real unit tests through
  the existing `node:vm` harness (`tests/unit/adjuster/loadGs.ts`), per ADR 006:
  `classifyRetellGap(sheetRow, call)` returning
  `{ action: 'none' | 'ended' | 'analyzed' | 'both', reason }`.
  Cases: no row, `awaiting_analysis`, `awaiting_call_ended`, `pending`, `done`,
  `failed`, below duration floor, and a row present with both markers set.
- Deploy with no n8n schedule attached and verify by curling the route.

### Phase 2 — Prove it on a real gap

- Create a genuine gap: point the Retell webhook at a dead URL, place a test
  call, let all 3 retries fail, restore the webhook.
- Run the sweep and confirm the job lands identically to a webhook-ingested
  call (same columns populated, recording in Drive, status `pending`).
- Repeat for the half-delivered case by blocking only `call_analyzed`.

### Phase 3 — Schedule and observe

- Add the hourly n8n workflow, same four-node shape as spec 024.
- Alert on `ok === false` **and** on `gaps_found > 0`.
- Observe for a week and record the real gap rate in the ADR. A gap rate of
  zero is itself worth knowing; it tells you the webhook path is sound and this
  is pure insurance.

## Edge Cases & Risk

| Risk                                                                                                                  | Likelihood | Impact | Mitigation                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `get-call` omits `collected_dynamic_variables`/`call_analysis`, making the analyzed half unrepairable without charges | M          | H      | Phase 0 verifies before any code is written; fallback is `rerunCallAnalysis` as an explicit, costed decision                        |
| Sweep re-ingests a call an operator deliberately deleted from the sheet                                               | L          | M      | Bounded 24h window means it self-limits after a day. If it becomes a real annoyance, an ignore-list Script Property is the fix      |
| Repair races a late webhook retry for the same call                                                                   | M          | L      | `upsertJob` keys on `capture_id`; both paths take `withJobLock`                                                                     |
| Recording re-copied to Drive on repair, duplicating storage                                                           | L          | L      | Classification targets only the missing half, so `handleRetellCallEnded` is never re-run on a job that already has `audio_drive_id` |
| Sweep hits the 6-min execution cap repairing several calls at once                                                    | L          | M      | `RETELL_RECONCILE_MAX_REPAIRS` cap of 5; overflow is reported as `deferred` and picked up next hour                                 |
| Misdials and wrong numbers pulled into the sheet as jobs                                                              | M          | L      | `duration_ms` floor of 30s applied in the API filter, before anything is examined                                                   |
| Retell API down or rate-limiting                                                                                      | L          | L      | Sweep fails, returns `ok: false`, n8n alerts, next hour retries. No state is corrupted by a failed sweep                            |
| `RETELL_API_KEY` used for both HMAC verification and API auth, so rotating it breaks two things at once               | M          | M      | Already true today for signature verification. Document the coupling in the runbook so rotation is known to affect both paths       |
| Sweep masks a systemic webhook outage by quietly fixing it                                                            | M          | M      | Alert on `gaps_found > 0`, not only on failure. Silent self-healing is how a broken webhook stays broken for months                 |

## Acceptance Criteria

- [ ] Phase 0 findings recorded: whether `list-calls` returns full call objects,
      and whether analysis data is present in the API response
- [ ] `event=retell_reconcile` returns `{"ok": true, "gaps_found": 0}` when the
      sheet and Retell agree
- [ ] A call whose webhooks all failed is recovered to `pending` with recording
      in Drive, transcript populated, and the same columns a webhook ingest sets
- [ ] A job at `awaiting_analysis` is promoted to `pending` by the sweep
- [ ] A job at `awaiting_call_ended` is promoted to `pending` by the sweep
- [ ] A job at `done`, `failed`, or any in-flight status is left untouched
- [ ] Running the sweep twice in a row produces no duplicate rows and no second
      Drive copy of the recording
- [ ] Calls shorter than the duration floor are never ingested
- [ ] `classifyRetellGap` unit tests pass across all eight cases listed in Phase 1
- [ ] Repair cap respected; overflow reported as `deferred` rather than dropped
- [ ] n8n alerts on both `ok === false` and `gaps_found > 0`
- [ ] No new secrets; `RETELL_API_KEY` reused from Script Properties
- [ ] `pnpm typecheck`, `pnpm format`, `pnpm lint` pass
- [ ] `pnpm test` passes
