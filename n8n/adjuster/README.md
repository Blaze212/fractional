# Adjuster n8n workflows

Workflows belonging to the Adjuster pipeline. See `../README.md` for the export
contract that governs every file under `n8n/`.

## `runner-drain.workflow.json`

Replaces the Apps Script every-minute time trigger that used to drive
`runPipelineTick()`. See `docs/specs/024-adjuster-n8n-pipeline-scheduler.md` and
the ADR it cites.

Every 15 minutes it calls `GET /texml/gas?t=<secret>&event=runner_drain`, which
runs `drainPipeline()` (`apps/adjuster/src/runner.js`). The drain empties the
queue inside a 240-second budget rather than advancing one job by one stage, so
a call reaches `done` in a single pass instead of waiting for a second tick.

### Already on the instance

This workflow exists on https://n8n.cmcareersystems.org as
**Adjuster — pipeline drain** (`tqzMcVXyw77tH1ha`), created from this
definition. It is **inactive and has no credential attached**, so it cannot
fire. Two steps remain, both of which have to happen in the n8n UI because a
credential value must never pass through the repo or a transcript:

1. Create the credential (see below) and select it on the **Drain the pipeline**
   node.
2. Activate the workflow.

The JSON file below stays the source of truth. Re-export over it if the workflow
is edited in the UI.

### Importing it fresh

1. n8n → Workflows → Import from File → pick `runner-drain.workflow.json`.
2. Create the credential before the first run (see below), then open the
   **Drain the pipeline** node and select it. The exported file carries the
   placeholder `REPLACE_WITH_CREDENTIAL_ID`; n8n will not run the node until a
   real credential is attached.
3. Activate the workflow.

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

`proxyToAppsScript` (`apps/bh-systems/src/worker.js`) answers a proxy-layer
failure — Apps Script cold-start timeout, network blip, bad `GAS_EXEC_URL` — with
**HTTP 200** carrying a TeXML `<Say>…<Hangup/>` body. That is correct for Telnyx,
which needs a clean hangup rather than an error, and it is why no Worker change
was in scope for spec 024. It also means a workflow that trusted the status code
would report green while the pipeline was dead.

**Did the drain report ok?** checks `$json.ok` is boolean true. Type validation is
deliberately loose: on the TeXML path the body is not JSON at all, so `$json.ok`
is `undefined` and the check routes to the failure branch instead of throwing.

Do not "simplify" this node into a status-code check.

### The failure branch

**Alert — drain failed** is a `stopAndError`, which despite the name alerts
nobody by itself. All it does is mark the execution failed, which is exactly the
point: a failed execution is the event an error workflow subscribes to. It is the
bridge between "the drain replied but said it was not ok" and "somebody gets
told". See `../shared/error-handler-slack.workflow.json` for the other half.

Do not replace it with a Slack node on the false branch. That branch only catches
the case where the drain answered and reported not-ok; it never sees the HTTP node
timing out or failing to reach the Worker, because those kill the execution before
control reaches the IF. It would also leave every broken run showing green.

### Timeout

The HTTP node's timeout is **660000 ms (11 min)**, and the arithmetic matters.
The drain checks its 240-second budget BEFORE starting an iteration and never
during one, so an iteration that starts at 239s can still run until the Apps
Script 6-minute execution cap kills it: 240s + 360s = 600s worst case, with the
remaining minute covering proxy and network overhead.

The 5 minutes originally specified in docs/specs/024 is below that bound. A
timeout under it makes n8n abandon the request and take the failure branch while
Apps Script is still working normally — a false alarm that looks exactly like a
dead pipeline. If you shorten the budget in `runner.js`, shorten this too — in
that order.

### Overlapping runs

Safe, and no n8n-side concurrency limit is needed. `drainPipeline()` takes the
script lock per iteration and every job carries a lease, so a second drain that
starts while the first is mid-pass either leases a different job or returns
`stopped_because: "lock_unavailable"` with `ok: true` and exits.

### Verifying a change

`{"ok": true, "stopped_because": "queue_empty"}` on an empty queue is the
smoke test. Curl it directly rather than waiting for the schedule:

```bash
curl -s 'https://www.bh-systems.com/texml/gas?t=<WEBHOOK_SECRET>&event=runner_drain'
```

Then break it on purpose — a wrong `t` must land in the failure branch, not the
success branch.
