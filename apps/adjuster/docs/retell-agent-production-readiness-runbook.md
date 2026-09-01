# Retell agent production readiness — runbook

**Status:** In progress — tracks Linear [BH-40](https://linear.app/skoodar/issue/BH-40) (Brandon Adjuster / Phase 0: Retell alongside Dograh)
**Agent:** `Brandon Note Taker` (`agent_978b3f2ffd4bc9f0ff594f1d17`), voice `Kate`, conversation flow `conversation_flow_748430920154`

This is a config runbook, not a code change. The items below are live settings on Brandon's Retell agent/phone number, checked against the account via the Retell API on 2026-09-01. None of the mutations below have been applied yet — see "Sequencing" for why.

## Current state (read via `getAgent`, 2026-09-01)

| Setting                           | Current value                                                                                                                                                                                                                                                                                                 | Target                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `max_call_duration_ms`            | `900000` (15 min)                                                                                                                                                                                                                                                                                             | `2700000` (45 min)                                                                                             |
| `opt_in_signed_url`               | `false`                                                                                                                                                                                                                                                                                                       | `true`                                                                                                         |
| `pii_config.categories`           | `[]` (mode `post_call`)                                                                                                                                                                                                                                                                                       | **Blocked — see below**                                                                                        |
| Data retention                    | not surfaced by `getAgent` as `data_storage_retention_days`; agent has `data_storage_setting: "everything"`. Need to check the workspace-level retention setting (Retell's docs describe retention as an account/workspace setting, not always a per-agent field) before this checklist item can be actioned. | **Blocked — see below**                                                                                        |
| Conversation flow / agent version | Draft `version: 3` exists (`is_published: false`) on top of published `base_version: 2`. The phone number currently routes inbound calls to the published v2.                                                                                                                                                 | Publish v3 — **sequencing-blocked, see below**                                                                 |
| Persona                           | `voice_id: retell-Kate` (voice "Kate"). The global prompt text in conversation flow v3 needs to be read directly (not returned by `getAgent`) to confirm whether it still says "Sam" as reported. **Unverified — flagging for confirmation, not fixing blind.**                                               | Global prompt should refer to the agent as "Kate" (or whichever name Brandon wants), consistent with the voice |
| `webhook_url`                     | not set                                                                                                                                                                                                                                                                                                       | Point at the bh-systems Worker proxy — **sequencing-blocked, see below**                                       |

## Blocked on Brandon's decision — do not set unilaterally

- **`pii_config.categories`** — currently `[]`, which means _nothing_ is redacted from call recordings/transcripts today. This is a real-world PII exposure question for an insurance-claims product; Barton is not deciding what gets redacted on Brandon's behalf. Needs an explicit conversation with Brandon about which categories (if any) to enable.
- **Data retention** — deletion under a retention policy is irreversible. Same rule: needs Brandon's explicit sign-off on a number before this gets set, not a default picked for him.

## Blocked on sequencing — do after spec 014 ships

- **`webhook_url`** — pointing this at the Worker proxy before the Retell ingest code (spec 014, Linear BH-41) is deployed and verified would mean real production call events get dropped or 404 while Brandon is presumably making real calls. Set this only after spec 014's PR is merged and clasp-deployed.
- **Publishing conversation flow v3 / agent v3** — this immediately changes behavior for every live call on the bound number. Should happen in the same window as the webhook cutover above, not before, and ideally alongside (or right after) the scripted A/B call comparison from spec 017 (Dograh regression guard) so there's a live before/after reference.

## Safe to apply now (mechanical, reversible, no judgment call)

These two are uncontroversial per the original breakdown and don't gate on anything else:

- Raise `max_call_duration_ms` from `900000` to `2700000` (45 min).
- Enable `opt_in_signed_url` so recording URLs are signed.

**Not yet applied in this pass** — flagging them here rather than pushing a live mutation to Brandon's production agent from an unattended runbook write-up. These two are low-risk and don't block on anything above; get explicit go-ahead before applying them via the Retell API.

## Checklist (for whoever executes the remaining items)

- [ ] Raise `max_call_duration_ms` to 45 min
- [ ] Enable `opt_in_signed_url`
- [ ] Get Brandon's PII redaction decision, set `pii_config.categories` accordingly
- [ ] Confirm the actual data-retention mechanism (workspace vs per-agent setting) and get Brandon's retention-days decision
- [ ] Read conversation flow v3's global-node prompt text directly, confirm/fix "Sam" vs "Kate" persona drift
- [ ] After spec 014 (BH-41, Retell ingest) merges and is clasp-deployed: set `webhook_url` to the bh-systems Worker proxy
- [ ] After the above: publish conversation flow v3 and agent v3 together, ideally alongside the spec 017 A/B call comparison
