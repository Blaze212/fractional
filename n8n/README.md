# n8n workflows

n8n is not provisioned from this repo, and nothing here deploys itself. These
files are the **source of truth for what the instance should be running**, kept
in Git so a workflow is reviewable, diffable, and recoverable if the instance is
lost.

Instance: https://n8n.cmcareersystems.org

## Layout

```
n8n/
  adjuster/   workflows belonging to the Adjuster pipeline
  shared/     workflows used by more than one project
```

One folder per project. A workflow earns a place in `shared/` by actually being
named by two or more workflows, not by looking reusable.

## The export contract

**A workflow edited in the n8n UI must be re-exported back over its file here.**
This is the part that rots if nobody does it. The files below were exported from
the live instance, so they match it as of the last commit that touched them — but
n8n has no hook that tells this repo when somebody drags a node, and a stale
export is worse than none because it is trusted.

When exporting, keep the instance's own values — node IDs, `typeVersion`s,
positions. Do not tidy them by hand. A file that has been prettified away from
what n8n actually stores will produce a confusing diff the next time it is
exported properly.

## Credentials are never committed

Every workflow that authenticates carries a placeholder:

```json
"credentials": { "httpQueryAuth": { "id": "REPLACE_WITH_CREDENTIAL_ID", "name": "..." } }
```

Credentials live in n8n and nowhere else. The n8n API redacts them from workflow
reads, so an export cannot leak one by accident — but it also means an imported
file will not run until the credential is selected on the node by hand. That is
the intended trade, not a rough edge to smooth over.

## Index

| File                                       | Purpose                                                        | On the instance    |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------ |
| `adjuster/runner-drain.workflow.json`      | Drives the Adjuster pipeline drain every 15 minutes (spec 024) | `tqzMcVXyw77tH1ha` |
| `shared/error-handler-slack.workflow.json` | Posts any failed workflow to Slack `#alarms`                   | `DDGVlGUlKBuXdQ5H` |

## `shared/error-handler-slack.workflow.json`

The other half of the failure path. An n8n **error workflow** is not a node and
not a branch — nothing on the drain's canvas points at it. It is a separate
workflow starting with an Error Trigger, named once under the drain's
Options → Settings → **Error workflow**, and n8n runs it _after_ an execution has
already failed. That is why it catches failures no branch could: a timeout, an
unreachable Worker, any node erroring.

On the instance as **Error handler — Slack #alarms** (`DDGVlGUlKBuXdQ5H`), with
the existing `Slack account` credential attached. It posts the failing workflow's
name, the error message, the last node executed, and a link to the execution.

Deliberately generic, not adjuster-specific: one error workflow can serve every
workflow on the instance, so spec 025's reconcile sweep should name this same one
rather than growing its own.

### Two things about it that are easy to get wrong

**It does not need activating.** Per n8n's docs: "If a workflow uses the Error
Trigger node, you don't have to publish the workflow." Leave it inactive. Setting
it under the drain's settings is the only wiring it needs.

**You cannot test it by running the drain manually.** Also from the docs: "You
can't test error workflows when running workflows manually. The Error Trigger only
runs when an automatic workflow errors." So the wrong-secret test below has to be
left to the 15-minute schedule. Break the secret, wait for the schedule to fire,
and check Slack. Triggering the drain by hand will show the red execution and no
Slack message, which looks exactly like broken alerting and is not.
