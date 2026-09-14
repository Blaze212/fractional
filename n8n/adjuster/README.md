# Adjuster n8n workflows

Workflows belonging to the Adjuster pipeline. See `../README.md` for the export
contract that governs every file under `n8n/`.

## `runner-drain.workflow.json`

Replaces the Apps Script every-minute time trigger that used to drive
`runPipelineTick()`. See `docs/specs/024-adjuster-n8n-pipeline-scheduler.md` and
the ADR it cites.

Every 15 minutes it calls
`GET <GAS_EXEC_URL>?t=<secret>&event=runner_drain`, which runs
`drainPipeline()` (`apps/adjuster/src/runner.js`). The drain empties the queue
inside a 240-second budget rather than advancing one job by one stage, so a call
reaches `done` in a single pass instead of waiting for a second tick.

### Why this calls Apps Script directly and not the Worker

It used to go through `https://www.bh-systems.com/texml/gas`, and that is what
produced `error code: 524` on any drain with real work in it.

524 is **Cloudflare's origin timeout**, fired at the edge between n8n and the
Worker at roughly 100 seconds. It is not configurable outside an Enterprise
plan, and it has nothing to do with the HTTP node's own timeout — on the
execution that exposed this the node was set to 660000 ms and still died at
125 s wall clock, because the connection was already gone. Empty-queue drains
returned in 6-11 s and looked healthy; the first pass with a real job took 63 s,
and the next one crossed the ceiling.

That ceiling is far below what the drain is allowed to take. The budget is 240 s,
checked _before_ an iteration and never during one, on top of Apps Script's
6-minute cap — a 600-second worst case by design (see **Timeout** below). Behind
Cloudflare, anything past 100 s was unreachable.

**The Worker was never needed on this path.** `proxyToAppsScript` exists for one
reason, stated in `apps/bh-systems/src/worker.js`: Apps Script's `/exec` always
answers 302 to a `script.googleusercontent.com` URL carrying the real body, and
Telnyx's TeXML callbacks do not follow that hop. n8n's HTTP Request node follows
redirects natively, so it can talk to `/exec` directly. Doing so removes the
Cloudflare ceiling entirely and leaves Apps Script's own 6-minute cap as the only
limit, comfortably inside the node's timeout.

Nothing about the Worker changed. Every telephony and webhook route still goes
through `/texml/gas`, which is still the only way Telnyx and Retell can reach the
script.

The cost is that the `/exec` URL now lives in two places: this workflow and the
Worker's `GAS_EXEC_URL` secret. `docs/specs/022`'s BH-107 reissues that URL when
the script moves to Brandon's account, and both have to be updated then.

### Already on the instance

This workflow exists on https://n8n.cmcareersystems.org as
**Adjuster — pipeline drain** (`tqzMcVXyw77tH1ha`). It is **active**, has the
credential below attached, and names **Error handler — Slack #alarms**
(`DDGVlGUlKBuXdQ5H`) under Settings → Error Workflow.

The JSON file stays the source of truth. Re-export over it if the workflow is
edited in the UI — and re-apply both placeholders below before committing, since
neither value belongs in a public repo.

### Importing it fresh

1. n8n → Workflows → Import from File → pick `runner-drain.workflow.json`.
2. Open the **Drain the pipeline** node and replace `REPLACE_WITH_GAS_EXEC_URL`
   with the Apps Script `/exec` URL — the same value as the Worker's
   `GAS_EXEC_URL` secret and CI's `GAS_EXEC_URL`. It is not committed: this repo
   is public, and while `/exec` is gated by `WEBHOOK_SECRET`, publishing the
   endpoint widens the surface for no benefit.
3. Create the credential before the first run (see below), then select it on the
   same node. The exported file carries the placeholder
   `REPLACE_WITH_CREDENTIAL_ID`; n8n will not run the node until a real
   credential is attached.
4. Set Settings → Error Workflow to **Error handler — Slack #alarms**, or a
   failure only turns the execution red and tells nobody.
5. Activate the workflow.

### The credential

The shared secret goes in an n8n credential, never inline in the node.

- Type: **Query Auth** (`httpQueryAuth`)
- Name: `Adjuster WEBHOOK_SECRET (t)`
- Parameter name: `t`
- Value: the same `WEBHOOK_SECRET` already in Apps Script Script Properties and
  `apps/bh-systems/.env`. No new secret is created and nothing goes in Doppler —
  Adjuster is outside the Doppler-managed surface per ADR 006.

The node's own query parameters carry only `event=runner_drain`; the credential
appends `t`. That keeps the secret out of the exported JSON, which is why this
file is safe to commit.

### Why the IF asserts on the body and not the status code

**Did the drain report ok?** checks `$json.ok` is boolean true. Type validation is
deliberately loose, because every failure shape this node has actually seen
answers with a body that is not the drain's JSON at all, leaving `$json.ok`
`undefined` so the check routes to the failure branch instead of throwing:

- **Cloudflare 524** (`{"data": "error code: 524\n"}`), back when this went
  through the Worker. See above.
- **A Google error page.** When the script was moved into a standard Cloud
  project its authorization was revoked, and `/exec` served a 403 Drive
  "You need access" HTML page to every anonymous caller for about half an hour.
- **A TeXML hangup.** `proxyToAppsScript` answers a proxy-layer failure with
  **HTTP 200** carrying `<Say>…<Hangup/>`, which is correct for Telnyx and means
  a caller trusting the status code reads a dead pipeline as healthy. The drain
  no longer goes through the Worker, so it will not see this one — but the
  reasoning is why the assertion is shaped this way, and it still applies to
  anything else that starts proxying this call.

A status code is wrong for all four: two of them are not even 5xx. Do not
"simplify" this node into a status-code check.

### The failure branch

**Alert — drain failed** is a `stopAndError`, which despite the name alerts
nobody by itself. All it does is mark the execution failed, which is exactly the
point: a failed execution is the event an error workflow subscribes to. It is the
bridge between "the drain replied but said it was not ok" and "somebody gets
told". See `../shared/error-handler-slack.workflow.json` for the other half.

Do not replace it with a Slack node on the false branch. That branch only catches
the case where the drain answered and reported not-ok; it never sees the HTTP node
timing out or failing to reach Apps Script, because those kill the execution
before control reaches the IF. It would also leave every broken run showing green.

**A manual run will never post to Slack, and that is n8n's behaviour, not a
misconfiguration.** Error workflows fire for automatic executions only, so
hitting Execute Workflow on a drain you have deliberately broken turns the
execution red and stops there. Testing this needs a real tick: break the secret,
wait for the schedule, then fix it. Every failure investigated so far that
"didn't alert" was a manual execution.

### Timeout

The HTTP node's timeout is **660000 ms (11 min)**, and the arithmetic matters.
The drain checks its 240-second budget BEFORE starting an iteration and never
during one, so an iteration that starts at 239s can still run until the Apps
Script 6-minute execution cap kills it: 240s + 360s = 600s worst case, with the
remaining minute covering network overhead.

The 5 minutes originally specified in docs/specs/024 is below that bound. A
timeout under it makes n8n abandon the request and take the failure branch while
Apps Script is still working normally — a false alarm that looks exactly like a
dead pipeline. If you shorten the budget in `runner.js`, shorten this too — in
that order.

This number was untestable while the call went through Cloudflare: the edge cut
every request at ~100s, so the node's timeout was dead configuration and the
600-second bound above was unreachable. Calling `/exec` directly is what makes
it the real limit rather than a theoretical one, which is why it stays at
660000 ms rather than being trimmed to match observed durations.

### Overlapping runs

Safe, and no n8n-side concurrency limit is needed. `drainPipeline()` takes the
script lock per iteration and every job carries a lease, so a second drain that
starts while the first is mid-pass either leases a different job or returns
`stopped_because: "lock_unavailable"` with `ok: true` and exits.

### Verifying a change

`{"ok": true, "stopped_because": "queue_empty"}` on an empty queue is the
smoke test. Curl it directly rather than waiting for the schedule:

```bash
curl -sL '<GAS_EXEC_URL>?t=<WEBHOOK_SECRET>&event=runner_drain'
```

`-L` is not optional: `/exec` always answers 302 to
`script.googleusercontent.com`, and the redirect is what carries the body. That
hop is the entire reason `proxyToAppsScript` exists for Telnyx, and the reason
n8n can skip it.

Then break it on purpose — a wrong `t` must land in the failure branch, not the
success branch. Do that on the **schedule**, not with Execute Workflow, or the
Slack half goes untested (see **The failure branch**).
