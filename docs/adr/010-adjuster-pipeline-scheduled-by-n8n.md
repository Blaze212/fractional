# ADR 010 — The Adjuster Pipeline Is Scheduled by n8n, and Drains Rather Than Ticks

**Status:** Accepted
**Date:** 2026-09-13
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/024-adjuster-n8n-pipeline-scheduler.md

---

## Context

`runPipelineTick()` ran on an Apps Script every-minute time trigger and advanced
exactly one job by exactly one stage. The pipeline is a two-stage machine
(ADR 006, spec 012), so a single call needed at minimum two invocations to reach
`done`.

That shape has a quota problem. Apps Script's **triggers total runtime** quota is
90 min/day on a consumer account and 6 hr/day on Google Workspace
(https://developers.google.com/apps-script/guides/services/quotas). The project
currently lives on a Workspace account, where 1440 daily ticks — the
overwhelming majority of them no-ops logging `runner.no_pending_jobs` — are
invisible against a 6-hour ceiling. ADR 006 plans to transfer Drive, Doc, and
Script ownership to Brandon after stage 4 passes. If that target account is
consumer gmail.com, the every-minute trigger consumes most or all of 90 minutes a
day doing nothing, and the first real inspection call after the migration has no
quota left to run in.

The failure mode on quota exhaustion is silent. Triggers stop firing, no error
surfaces in the Sheet, and a job sits at `pending` indefinitely.

The secondary problem is the one that prompted the work: 1440 daily executions
make the Apps Script execution log unusable for finding the handful of entries
that describe a real call.

## Decision

**Scheduling moves out of Apps Script and into a self-hosted n8n instance, and
the pipeline changes from ticking to draining.**

A new `event=runner_drain` route in `routeWebhook()` dispatches to
`drainPipeline()`, which runs `reclaimStuckJobs()` and
`ensureTranscriptionColumns()` once per pass rather than once per job, then loops
`processOldestPendingJob()` until the queue is empty, a 240-second wall-clock
budget is spent, or a 20-iteration cap is hit. An n8n Schedule Trigger calls it
every 15 minutes through the existing `bh-systems` Worker proxy.

`runPipelineTick()` is kept so a manual single-step run stays available from the
Apps Script editor.

Nothing changes in the call path. The Worker, the Retell signature translation,
and every ingest route are untouched.

### The quota arithmetic

|                                        | Before     | After        |
| -------------------------------------- | ---------- | ------------ |
| Apps Script executions/day             | ~1440      | ~96          |
| Trigger runtime/day                    | ~60-70 min | under 10 min |
| Consumer-account headroom (90 min/day) | none       | ample        |

### Lock discipline — the constraint that shapes the design

This is the part a future refactor is most likely to undo, so it is recorded
here rather than only in a code comment.

`runPipelineTick()` used to hold `LockService.getScriptLock()` across its entire
execution, and `processOldestPendingJob()` inherited that outer lock.
`withJobLock()` (`jobs.js`) takes **the same script lock** with `tryLock(30000)`,
and every webhook handler that mutates the Jobs tab must hold it.

Under one-minute ticks the hold is short and contention is rare. A drain that
wrapped its whole loop in the inherited lock would hold it for up to four
minutes, and every Retell and Dograh webhook arriving in that window would
exhaust its 30-second `tryLock` and throw "Timed out waiting for the job lock."
Ingest would fail for a quarter of every cycle, and nothing in either vendor
dashboard would explain why.

**`processOldestPendingJob()` therefore acquires and releases the script lock
itself, once per job.** A webhook arriving mid-drain waits for one stage
boundary, not for the whole drain. `runner.test.ts` asserts the acquire/release
timeline strictly alternates across a multi-job drain. Do not hoist the lock back
out to the caller.

### Why the n8n IF node asserts on the body

`proxyToAppsScript` (`apps/bh-systems/src/worker.js`) answers a proxy-layer
failure with **HTTP 200** carrying a TeXML `<Say>…<Hangup/>` body. That is
correct for Telnyx, which needs a clean hangup rather than an error, and it is
why no Worker change was in scope. It also means a drain that fails at the proxy
layer reaches n8n as a 200 carrying XML. The workflow checks `$json.ok === true`
and never the status code. A workflow that trusts the status code reports green
while the pipeline is dead.

### Why event-driven fan-out was deferred, not rejected

The alternative was for the Worker to fire an n8n webhook after ingest via
`ctx.waitUntil()`, making draft generation event-driven with near-zero latency.

It was **deferred, not rejected.** A 15-to-30-minute latency budget is acceptable
for draft generation, and the scheduled drain meets it: a call finishing at T is
picked up within 15 minutes and, because the drain loops rather than
single-steps, runs both stages in that one pass. The fan-out design adds a
failure surface in the call path — the thing this change deliberately left alone
— to buy latency nobody is asking for. It stays available if the latency
requirement tightens.

### Lease length

Tightened from 10 minutes to 7 (`leaseJob`, `runner.js`). The lease only needs to
outlast the 6-minute execution cap. The extra three minutes were near-invisible
when reclaim ran every minute; with reclaim now running once per 15-minute drain,
they are three minutes added to every recovery.

## Consequences

**n8n becomes an external orchestration dependency**, which partially supersedes
ADR 006's implicit position that triggers are internal to a single self-contained
Apps Script project. ADR 006 scoped the project that way to keep the whole system
inside one artifact Brandon could own; scheduling now lives somewhere else, and
the account migration has to account for it.

**If n8n is down or the workflow is disabled, the pipeline stalls silently** —
the same failure mode a dead trigger has today. The failure branch covers the
call failing, not n8n being down. Accepted for a single-user MVP; a dead-man's
switch is the follow-up if this outlives the MVP.

**The every-minute trigger must be deleted by hand** from the Apps Script UI. It
was installed by hand and is not in the repo, so there is nothing to remove from
code and nothing that would recreate it on the next `clasp push`. Recorded here
because that is the only place it is written down.

**`WEBHOOK_SECRET` now also lives in an n8n credential.** Same secret, one more
store, no new exposure surface beyond the publicly reachable Worker route it
already gates. Nothing goes in Doppler — Adjuster is outside the Doppler-managed
surface per ADR 006.

**Worst-case recovery from a killed stage is longer**: lease expiry plus one
interval, about 22 minutes with a 7-minute lease, against about 11 minutes
before. Acceptable against the same 15-to-30-minute latency budget.

**`stopped_because` carries a fourth value beyond the three in spec 024** —
`lock_unavailable`, returned with `ok: true` when a second drain finds the first
still mid-pass. Overlap is expected under a 15-minute schedule and a 4-minute
budget, and it is a no-op exit rather than a failure, so n8n stays green.

## Rollout state

Recorded here because the cutover spans three systems and only one of them is
the repo.

**Apps Script deploys itself on merge.** `.github/workflows/ci.yml` runs
`clasp push -f` and `clasp redeploy` against the Production environment on every
push to `main` (job: _Deploy Adjuster Apps Script_). The `event=runner_drain`
route therefore goes live when this PR merges; no hand deploy is needed, and an
earlier handoff note that called this a manual step was wrong.

**The n8n workflow exists but is inert.** Created on
https://n8n.cmcareersystems.org as **Adjuster — pipeline drain**
(`tqzMcVXyw77tH1ha`) from `n8n/adjuster/runner-drain.workflow.json`. It is
inactive and carries no credential, so it cannot fire. The credential must be
made in the n8n UI rather than from here: its value is `WEBHOOK_SECRET`, and a
secret should not pass through a repo, a tool call, or a transcript to get where
it is going.

**Order matters.** Merge first so CI deploys the route, then attach the
credential and activate. Activating against an undeployed route sends every
execution to the failure branch.

**Still open at the time of writing:**

- Brandon's Google account type (consumer or Workspace) is unconfirmed. The
  quota arithmetic above holds either way, so this changes urgency, not design.
  It belongs in this ADR once known.
- The error workflow exists — **Error handler — Slack #alarms**
  (`DDGVlGUlKBuXdQ5H`), posting to `#alarms` — but the drain does not name it yet.
  Until it is selected under the drain's Options → Settings → Error workflow,
  a failure still only turns the execution red, which is the same silent failure
  this ADR replaces. The error workflow itself needs no activation, and cannot be
  tested by running the drain by hand: n8n fires an Error Trigger only for
  automatic executions, so the wrong-secret test has to wait for the schedule.
- The every-minute trigger is still installed and must be deleted by hand.
- The 48-hour observation (trigger runtime under 10 min/day, about 96
  executions/day, no stalled jobs) has not run.

**One spec number was wrong and is corrected here.** Spec 024 specified a
300000 ms (5 min) HTTP timeout and called it comfortably above the budget plus
one overrunning stage. It is not: the 240-second budget is checked before an
iteration and never during one, so an iteration starting at 239s runs until the
Apps Script 6-minute cap, for a 600-second worst case. The workflow and the spec
now use 660000 ms. A timeout below the real bound would take the failure branch
while Apps Script was still working normally — a false alarm indistinguishable
from a dead pipeline.

## Amendment (2026-09-14) — the drain calls Apps Script directly, not through the Worker

The decision above routed the schedule at `https://www.bh-systems.com/texml/gas`,
reusing the Worker proxy the telephony webhooks already went through. That is
wrong for this caller, and the way it failed is worth recording because nothing
about it looks like a timeout problem from inside n8n.

**Cloudflare answers 524 at roughly 100 seconds.** It is an edge timeout between
the client and the origin, not configurable outside an Enterprise plan, and it
has no relationship to the HTTP node's own timeout. The execution that exposed it
had that timeout set to 660000 ms and still died at 125 s wall clock with
`{"data": "error code: 524\n"}` as the body — the connection was already gone
when n8n's own clock was still eight minutes from expiring.

The ceiling sat far below what this ADR deliberately allows. The budget is 240 s,
checked before an iteration and never during one, on top of Apps Script's
6-minute cap: a 600-second worst case, reasoned through in the **Timeout**
section of `n8n/adjuster/README.md` and corrected upward once already when spec
024's 5 minutes proved too short. Behind Cloudflare none of that was reachable.
Empty-queue drains returned in 6-11 s and looked healthy; the first pass with a
real job took 63 s; the next crossed 100 s and failed.

**The Worker was never needed on this path.** `proxyToAppsScript` exists because
Apps Script `/exec` answers 302 to a `script.googleusercontent.com` URL carrying
the real body and Telnyx's TeXML callbacks do not follow that hop. n8n's HTTP
Request node follows redirects natively. Pointing the drain at `/exec` removes
the Cloudflare ceiling and leaves Apps Script's 6-minute cap as the only limit,
inside the node's timeout rather than outside it.

Nothing about the Worker or the call path changed. Every telephony and webhook
route still goes through `/texml/gas`.

**Consequence:** the `/exec` URL now lives in the n8n workflow as well as the
Worker's `GAS_EXEC_URL` secret and CI's. `docs/specs/022`'s BH-107 reissues that
URL when the script moves to Brandon's account; both have to change together, and
a drain left pointing at the old deployment fails closed rather than silently, so
the failure branch will say so.

It is not committed. The repo is public, and while `/exec` is gated by
`WEBHOOK_SECRET`, publishing the endpoint widens the surface for no benefit — so
`runner-drain.workflow.json` carries `REPLACE_WITH_GAS_EXEC_URL` alongside the
credential placeholder that was already there.

**This also closes two items left open under Rollout state.** The error workflow
is now named on the drain, and the every-minute Apps Script trigger is gone.

### A manual execution never fires the error workflow

Recorded here because it has now been mistaken for a broken alert more than once.
n8n runs error workflows for automatic executions only. Hitting Execute Workflow
on a drain that fails turns the execution red and posts nothing to Slack, which
is indistinguishable from a dead Slack node. The Rollout state section above
already noted this for the wrong-secret test; the general rule is that any
"it failed but did not alert" report should be checked against the execution's
`mode` before anything else.

## Alternatives considered

**Leave it on Apps Script and lengthen the trigger interval.** The longest Apps
Script time-trigger interval is every minute for minute-based triggers or hourly
above that. Hourly breaks the latency budget; every minute is the problem. It
also leaves the execution log unreadable.

**Cloudflare Cron Triggers on the existing Worker.** Would avoid a new dependency
and the Worker is already in the path. Rejected because Worker cron executions
have their own CPU limits and no searchable execution history, and because
putting scheduling in the Worker couples the call path to the pipeline clock —
the coupling this change spent effort avoiding.

**Event-driven fan-out from the Worker.** See above; deferred.
