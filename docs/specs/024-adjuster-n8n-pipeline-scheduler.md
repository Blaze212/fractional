# Move the Adjuster Pipeline Tick from an Apps Script Time Trigger to n8n

**Status:** Draft
**Owner:** Barton
**Last updated:** 2026-09-12

## Objective

Replace the Apps Script every-minute time trigger that drives
`runPipelineTick()` with a self-hosted n8n schedule calling a new
`event=runner_drain` webhook route, and change the pipeline from "advance one
job by one stage per invocation" to "drain the queue within a wall-clock
budget." This cuts Apps Script trigger runtime from roughly 1440 invocations a
day (the overwhelming majority of them no-ops logging `runner.no_pending_jobs`)
to roughly 96, moves execution history into n8n where it is searchable, and
brings the project inside the 90 min/day trigger-runtime quota that applies to
consumer Google accounts.

## Non-goals

- **Event-driven ticking off the Retell webhook.** A 15 to 30 minute latency
  budget is acceptable for draft generation, so the Worker fan-out design
  (Worker fires an n8n webhook after ingest via `ctx.waitUntil()`) is not built
  here. It stays available if the latency requirement tightens later.
- **Any change to `apps/bh-systems/src/worker.js`.** `proxyToAppsScript` already
  forwards the full query string (`target.search = url.search`), so
  `?t=<secret>&event=runner_drain` passes through untouched. See "The Worker
  reports failure as success" below for the one consequence this has.
- **Any change to ingest.** Retell, Dograh, and manual-inject routes in
  `routeWebhook()` keep their current contracts, signature verification, and
  handlers.
- **Any change to pipeline logic.** `runTranscriptionStage`, `runExtractionStage`,
  matching, extraction, and docgen are untouched. This spec changes only what
  decides _when_ and _how many times_ a stage runs.
- **Changing the auth scheme.** The drain route reuses the existing
  `params.t !== getConfig('WEBHOOK_SECRET')` gate that every event already
  passes through.
- **Retiring the hourly `syncClaimsFromCalendar` trigger** (`calendarSync.js:154`).
  At 24 invocations a day it is not a meaningful share of the quota. It stays
  on Apps Script.
- **n8n provisioning, hosting, or backup.** The instance is assumed to exist,
  be self-hosted, and be reachable.

## Business Rationale

This is a prerequisite for the account migration ADR 006 already records as
planned, not a cleanup task.

Apps Script's **triggers total runtime** quota is 90 min/day on a consumer
account and 6 hr/day on Google Workspace
(https://developers.google.com/apps-script/guides/services/quotas). The project
currently lives on Barton's Workspace account, where 1440 daily no-op ticks are
invisible against a 6-hour ceiling. ADR 006 plans to transfer Drive, Doc, and
Script ownership to Brandon after stage 4 passes. If Brandon's account is
consumer gmail.com, the every-minute trigger consumes most or all of 90 minutes
a day doing nothing, and the first real inspection call after migration has no
quota left to run in.

The failure mode on quota exhaustion is silent. Triggers stop firing, no error
surfaces in the Sheet, and a job sits at `pending` indefinitely. Fixing this
before the migration is cheaper than diagnosing it after.

The secondary benefit is the one that prompted the work: 1440 daily executions
make the Apps Script execution log unusable for finding the handful of entries
that describe a real call.

**Verification required before Phase 1:** confirm which account type Brandon's
Google account is. The design below fits inside 90 min/day either way, so this
does not change the work, only its urgency.

## Architecture

### Current state

```
Retell ──▶ Cloudflare Worker ──▶ Apps Script /exec ──▶ Jobs sheet
           bh-systems.com         doPost → routeWebhook        │
           /texml/gas             (signature → query param)    │
                                                               │
           Apps Script time trigger (every 1 min) ──▶ runPipelineTick() ──┘
```

`runPipelineTick()` (`apps/adjuster/src/runner.js:1`) does four things per
invocation, holding `LockService.getScriptLock()` across all of them:

1. `reclaimStuckJobs()` — full sheet scan, returns expired leases to `pending`
2. `ensureTranscriptionColumns()` — header check, writes any missing columns
3. `processOldestPendingJob()` — advances exactly one job by exactly one stage
4. `SpreadsheetApp.flush()` and release

The pipeline is a two-stage machine (`docs/specs/implemented/012`):
`pending → matching → transcribed → extracting → done`. Stage A (transcription:
two ASR round-trips plus a long-context merge) and stage B (extraction plus
docgen) are split because both together do not reliably fit inside the
6 min/execution cap. One tick advances one stage, so **a single call needs at
minimum two invocations to reach `done`.**

### Target state

```
Retell ──▶ Cloudflare Worker ──▶ Apps Script /exec ──▶ Jobs sheet
                                  doPost → routeWebhook        ▲
                                                               │
n8n Schedule Trigger (every 15 min)                            │
   └─▶ HTTP Request ──▶ Worker /texml/gas?t=…&event=runner_drain┘
       └─▶ assert response body, alert on failure
```

No new infrastructure in the call path. The Worker, the signature translation,
and every ingest route are unchanged.

### The drain contract

New route in `routeWebhook()` (`apps/adjuster/src/webhook.js:51`), placed
alongside the existing event branches and after the shared-secret gate:

```
GET or POST /texml/gas?t=<WEBHOOK_SECRET>&event=runner_drain
```

Dispatches to a new `drainPipeline()` in `runner.js`, which replaces
`runPipelineTick()` as the entry point. `runPipelineTick()` is kept as-is so a
manual single-step run stays available from the Apps Script editor.

`drainPipeline()`:

1. Runs `reclaimStuckJobs()` and `ensureTranscriptionColumns()` **once**, not
   once per job. Both are currently paid 1440 times a day to discover nothing
   changed.
2. Loops `processOldestPendingJob()` until any of:
   - no job was advanced (queue empty), or
   - the wall-clock budget is exhausted, or
   - the iteration cap is hit.
3. Returns a JSON summary.

**Budget: 240 seconds (4 min).** The check happens _before_ starting an
iteration, not during one, so the real worst case is 240s plus one full stage.
Stage A is the long pole and is itself bounded by the 6-minute execution cap,
so an iteration starting at 239s can still overrun. Accepted: the lease and
reclaim mechanism already handles a killed execution (see Risk table).

**Iteration cap: 20.** A guard against a job that advances without ever
reaching a terminal status, which would otherwise spin until the execution cap.

### Lock discipline (the constraint that shapes this design)

`runPipelineTick()` holds `LockService.getScriptLock()` for its entire
execution (`runner.js:3`). `withJobLock()` in `jobs.js:74`, which **every
webhook handler that mutates the Jobs tab must hold**, takes that _same script
lock_ with `tryLock(30000)`.

Today ticks are short, so contention is rare and 30 seconds is ample. A naive
drain that wrapped the whole loop in the existing lock would hold it for up to
4 minutes, and every Retell and Dograh webhook arriving in that window would
exhaust its 30-second `tryLock` and throw "Timed out waiting for the job lock."
Ingest would fail for a quarter of every drain cycle.

**Requirement: `drainPipeline()` must acquire and release the script lock once
per iteration, never across the loop.** Each `processOldestPendingJob()` call
takes the lock, advances one stage, flushes, and releases before the loop
re-enters. A webhook arriving mid-drain waits for one stage boundary, not for
the whole drain.

This is the single most important implementation detail in this spec. A drain
that regresses to whole-loop locking will present as intermittent webhook
failures that correlate with nothing visible in the Retell dashboard.

### Response contract

`drainPipeline()` returns JSON via `ContentService`:

```json
{
  "ok": true,
  "drain_id": "drain-1757692800000",
  "iterations": 3,
  "advanced": ["retell-abc123:transcribe", "retell-abc123:extract", "retell-def456:transcribe"],
  "stopped_because": "queue_empty",
  "reclaimed": 0,
  "ms": 48213
}
```

`stopped_because` is one of `queue_empty`, `budget_exhausted`, `iteration_cap`.
On an unhandled throw the existing `doPost` catch returns `{"ok": false}` with
the error, keeping the "every request produces exactly one terminal log line"
contract in `webhook.js` intact.

### The Worker reports failure as success

`proxyToAppsScript`'s catch block returns a TeXML `<Say>…<Hangup/>` body with
**HTTP 200** (`worker.js:52`). That is correct for Telnyx, which needs a clean
hangup rather than an error, and it is why no Worker change is in scope. But it
means a drain call that fails at the proxy layer (Apps Script cold-start
timeout, network blip, bad `GAS_EXEC_URL`) reaches n8n as a 200 carrying XML.

**Requirement: the n8n workflow must assert on the response body, not the
status code.** An IF node checks `$json.ok === true`. Anything else routes to
the failure branch. A workflow that trusts the status code will report green
while the pipeline is dead.

### n8n workflow shape

Four nodes, no Wait node, no loop:

1. **Schedule Trigger** — every 15 minutes.
2. **HTTP Request** — GET the Worker URL with `t` and `event=runner_drain`.
   Timeout set to **660000 ms (11 min)**. This spec originally said 300000 ms
   (5 min) and called it comfortably above the budget plus one overrunning
   stage; that arithmetic was wrong. The budget is checked before an iteration
   and never during one, so an iteration starting at 239s runs until the Apps
   Script 6-minute cap: 240s + 360s = 600s worst case. Five minutes sits below
   that bound and would take the failure branch while Apps Script was still
   working normally. Self-hosted n8n defaults `EXECUTIONS_TIMEOUT` to `-1`
   (no timeout), so nothing on the n8n side truncates this.
3. **IF** — `$json.ok === true`.
4. **Failure branch** — alert. Channel is an implementation choice; anything
   that reaches a human beats a silent false green.

The secret is stored in an n8n credential, never inline in the node. It is the
same `WEBHOOK_SECRET` already in Apps Script Script Properties and in
`apps/bh-systems/.env`; no new secret is created and nothing new goes in
Doppler (Adjuster is outside the Doppler-managed surface per ADR 006).

**Latency under this schedule:** a call finishing at T is picked up by the next
drain (≤15 min), and because the drain loops rather than single-stepping, it
runs both stages in that one pass. Worst case to `done` is about 15 minutes
plus stage runtime, inside the 15 to 30 minute budget. A morning of five
back-to-back inspections drains in one pass rather than taking 50 minutes at
one stage per invocation.

### Overlap and concurrency

Two drains can overlap if one runs long and the schedule fires again. This is
safe and needs no new mechanism: per-iteration locking plus the existing lease
means the second drain either leases a different job or finds none and exits.
No n8n-side concurrency limit is required, though setting the workflow to skip
if already running is harmless belt-and-braces.

### ADR

This warrants a new ADR in `docs/adr/`. Do not hardcode the number: `009` is
currently claimed by two separate in-flight branches
(`claude/gated-spec-adjuster-agent-2a8549` and
`claude/spec-21-implementation-f89051`), so pick the next free number against
`main` at implementation time. It changes the execution model,
introduces n8n as an external orchestration dependency for a project ADR 006
deliberately scoped to a single self-contained Apps Script project, and
partially supersedes ADR 006's implicit "triggers are internal to the script"
position. The ADR should record: the quota arithmetic, why the event-driven
Worker fan-out was deferred rather than rejected, and the lock-discipline
constraint so a future refactor does not undo it.

## Implementation Phases

Each phase is independently deployable and safe to stop at.

### Phase 0 — Confirm the quota picture

- Read the Apps Script project's execution history and confirm current daily
  trigger runtime.
- Confirm whether Brandon's target Google account is consumer or Workspace.
- No code changes.

### Phase 1 — Apps Script drain endpoint

Deployable with the every-minute trigger still running. Nothing calls the new
route yet, so behaviour is unchanged.

- Add `drainPipeline()` to `apps/adjuster/src/runner.js` with per-iteration
  locking, the 240s budget, and the 20-iteration cap.
- Extract the loop-control decision into a pure function with no Apps Script
  globals, so it is testable per ADR 006's rule:
  `shouldContinueDrain({ startedAtMs, nowMs, iterations, advancedLast })`
  returning `{ continue: boolean, reason: string }`.
- Refactor `processOldestPendingJob()` so lock acquisition lives at the
  per-job boundary rather than being inherited from `runPipelineTick()`'s
  outer lock. `runPipelineTick()` keeps its current external behaviour.
- Add `event=runner_drain` to `routeWebhook()`, after the secret gate.
- Return the JSON summary via `ContentService`.
- **Tests:** unit tests for `shouldContinueDrain` covering budget exhaustion,
  iteration cap, empty queue, and the boundary where budget and cap coincide.
  Loaded through the existing `node:vm` harness (`tests/unit/adjuster/loadGs.ts`).
- `clasp push` and redeploy. Verify by curling the route directly and
  confirming `{"ok": true, "stopped_because": "queue_empty"}` on an empty queue.

### Phase 2 — n8n workflow, running alongside the trigger

Both schedulers active. Safe because of per-iteration locking and leases.

- Build the four-node workflow.
- Set the interval to 15 minutes.
- Run a real test call end to end and confirm from the n8n execution log that
  the drain advanced it, not the minute trigger (distinguishable by `drain_id`
  in the Apps Script log).
- Deliberately break the call (wrong secret) and confirm the failure branch
  fires rather than reporting green.

### Phase 3 — Retire the time trigger

- Delete the `runPipelineTick` every-minute trigger from the Apps Script UI.
  It is installed by hand, not in code, so there is nothing to remove from the
  repo. Note this in the ADR so the next deploy does not recreate it.
- Tighten `lease_until` from 10 minutes to 7 (`runner.js:87`). The lease only
  needs to outlast the 6-minute execution cap; 10 minutes adds three minutes of
  dead time before a killed job can be reclaimed, which matters more now that
  reclaim happens every 15 minutes instead of every minute.
- Run for 48 hours and confirm daily trigger runtime, execution count, and that
  no job stalled.
- File the ADR, numbering it against `main` at the time (see Architecture).

## Edge Cases & Risk

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drain holds the script lock across the loop, starving webhook ingest | M          | H      | Per-iteration lock acquisition is a stated requirement; add a test asserting the lock is released between iterations                                                                                                                    |
| Drain killed at the 6-min execution cap mid-stage                    | M          | M      | Existing `leaseJob` + `reclaimStuckJobs` returns it to `pending`; next drain retries. Worst-case recovery is lease expiry plus one interval (~22 min with a 7-min lease)                                                                |
| Worker returns 200 + TeXML on proxy failure, n8n reads it as success | H          | H      | n8n asserts `$json.ok === true`, never the status code                                                                                                                                                                                  |
| n8n instance down or workflow disabled                               | M          | H      | Pipeline stalls silently, same failure mode as a dead trigger today. Failure branch alerting covers the call failing, not n8n being down. Accepted for a single-user MVP; a dead-man's-switch is the follow-up if this outlives the MVP |
| Job advances forever without reaching a terminal status              | L          | M      | 20-iteration cap; `stopped_because: "iteration_cap"` is the signal to investigate                                                                                                                                                       |
| Overlapping drains double-process a job                              | L          | M      | Per-iteration lock plus lease; second drain leases a different job or exits                                                                                                                                                             |
| `WEBHOOK_SECRET` now also lives in n8n credentials                   | H          | L      | Same secret, one more store. No new exposure surface beyond the publicly-reachable Worker route it already gates                                                                                                                        |
| Attacker discovers `event=runner_drain` and calls it repeatedly      | L          | M      | Secret-gated like every other route. Worst case is burned quota, not data loss; the route only advances jobs already in the sheet                                                                                                       |
| Latency budget breached under an unusually large backlog             | L          | L      | Drain loops rather than single-steps, so a backlog clears in one pass up to the budget; remainder clears next interval                                                                                                                  |

## Acceptance Criteria

- [ ] Brandon's Google account type confirmed and recorded in the ADR
- [ ] `event=runner_drain` returns `{"ok": true, ...}` with a correct
      `stopped_because` on an empty queue, a single-job queue, and a
      multi-job queue
- [ ] Drain advances a two-stage job from `pending` to `done` in **one**
      invocation
- [ ] Script lock is released between iterations, verified by a webhook POST
      succeeding while a multi-job drain is in flight
- [ ] `shouldContinueDrain` unit tests pass, covering budget, cap, empty queue,
      and the budget/cap boundary
- [ ] n8n workflow routes a wrong-secret response to the failure branch, not
      the success branch
- [ ] Every-minute `runPipelineTick` trigger deleted from the Apps Script UI
- [ ] Apps Script daily trigger runtime measured below 10 min/day over 48 hours
      (from ~60-70 min/day at the current rate)
- [ ] Apps Script execution count reduced from ~1440/day to ~96/day
- [ ] No job stalled over a 48-hour observation window
- [ ] ADR filed in `docs/adr/` with a number verified free against `main`
- [ ] No hardcoded secrets; `WEBHOOK_SECRET` in an n8n credential, not inline
- [ ] `pnpm typecheck`, `pnpm format`, `pnpm lint` pass
- [ ] `pnpm test` passes
