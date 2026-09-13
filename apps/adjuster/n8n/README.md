# n8n workflows for the Adjuster pipeline

Importable workflow definitions. n8n is not provisioned from this repo — these
are the source of truth for what the instance should be running, so a workflow
someone edits in the UI should be re-exported back over the file here.

## `runner-drain.workflow.json`

Replaces the Apps Script every-minute time trigger that used to drive
`runPipelineTick()`. See `docs/specs/024-adjuster-n8n-pipeline-scheduler.md` and
the ADR it cites.

Every 15 minutes it calls `GET /texml/gas?t=<secret>&event=runner_drain`, which
runs `drainPipeline()` (`apps/adjuster/src/runner.js`). The drain empties the
queue inside a 240-second budget rather than advancing one job by one stage, so
a call reaches `done` in a single pass instead of waiting for a second tick.

### Import

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

**Alert — drain failed** is a `stopAndError`, which marks the execution red and
fires whatever workflow is set under Settings → Error Workflow. That is a neutral
default, not a considered choice of channel: wire an error workflow, or swap the
node for Slack or email, so a failure actually reaches a person. A red execution
nobody looks at is the same silent failure the every-minute trigger had.

### Timeout

The HTTP node's timeout is **300000 ms (5 min)**, above the drain's 240-second
budget plus one overrunning stage. Self-hosted n8n defaults `EXECUTIONS_TIMEOUT`
to `-1`, so nothing on the n8n side truncates this. If you shorten the budget in
`runner.js`, shorten this too — in that order.

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
