# ADR 012 — Repeat Work Is a Bug: Stages Resume in Place and Enrichment Is Fingerprinted

**Status:** Accepted
**Date:** 2026-09-15
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/027-adjuster-stop-paying-for-repeat-work.md

---

## Context

OpenRouter credits reached $0 on 2026-09-15. Essentially none of the $20 bought
a new result. Two independent defects made the pipeline pay, repeatedly, for
work it already had.

A failed stage rewound the job to stage A. `failJob` wrote `pending` for every
failure, and `pending` is the queue stage A reads, so a failed extraction
re-entered transcription. One capture was transcribed through ElevenLabs six
times in 26 minutes — six paid ASR passes over a recording that transcribed
correctly on the first. The `attempts >= 3` guard that should have stopped it
could not fire: `failJob` read a pre-lease row snapshot, nothing on the failure
path wrote an attempt count back, and the clean-handoff reset handed every lap a
fresh budget of three.

Calendar sync made both of its LLM calls for every event in a 52-hour window on
every hourly tick, with no cache and no dirty check. That is about forty
enrichments per event before it ages out: 278 property lookups across 10
distinct events in 48 hours, seven of which already held complete data on their
Claims row and were re-searched to write back identical values.

## Decision

### Status is the queue, so a failed stage resumes at its own stage

`advanceOldestPendingJob` picks `transcribed` first and `pending` second. The
status a failure resumes at is therefore the choice of which stage runs next,
and the existing status vocabulary already expresses it:

| Failing stage | Leased status              | Resume status | Re-runs      |
| ------------- | -------------------------- | ------------- | ------------ |
| transcribe    | `matching`, `transcribing` | `pending`     | stage A      |
| extract       | `extracting`, `generating` | `transcribed` | stage B only |

This mapping lives in two places and must stay in agreement: `STAGE_RESUME_STATUS`
in `runner.js` for a stage that threw, and `LEASED_STATUS_RESUME` in `jobs.js`
for a lease that expired. No new state and no new column.

The general rule, of which the table is one instance: **no failure path may
rewind a job past work that already succeeded.** Any new stage added to this
machine has to answer the question the table answers before it ships.

### The attempt count is threaded, not re-read

`leaseJob` computes the authoritative attempt number when it writes the lease,
and now returns it. `advanceOldestPendingJob` holds that number and hands it to
`failJob`, which persists it alongside the status and logs it.

Re-reading the row inside `failJob` would cost another Sheet round trip inside
the lock and could still race. Threading is exact, and it makes
`runner.job_failed` truthful — that line reporting `attempts: 0` on a job's
sixth lap is a large part of why this went unnoticed for five days.

### A billing or auth failure fails the job immediately

401, 402 and 403 cannot succeed on a retry. The HTTP layer already knows this:
`callOpenRouter`'s retryable check is `status === 429 || status >= 500`, so it
does not retry them in-process. The job layer did, three times, at a full paid
stage each. A stage throwing a non-retryable vendor failure now goes straight to
`failed` and notifies.

The cost is that a mid-drain top-up no longer auto-recovers in the same pass.
That is the correct trade: the job is `failed`, visible and replayable, and
recovery is a deliberate replay rather than an accident of a retry budget.

### Calendar enrichment is keyed on a content fingerprint

Both calls are pure functions of text that lives on the event, so the Claims row
stores a fingerprint of each call's inputs and a tick skips the call when the
fingerprint matches.

| Call                    | Fingerprint over               | Re-runs when            |
| ----------------------- | ------------------------------ | ----------------------- |
| `extractCalendarFields` | title, location, description   | any of the three change |
| `lookupPropertyDetails` | the resolved full address text | the address changes     |

Three columns carry it — `calendar_fingerprint`,
`property_address_fingerprint`, `property_lookup_at` — appended to
`CLAIMS_CALENDAR_COLUMNS`. `ensureClaimsColumns()` runs at the top of every tick
and adds missing columns in place, so there is no migration and no backfill: the
first tick after deploy writes the columns and populates them, and every later
tick skips. A row written before they existed carries blank fingerprints, which
simply means "enrich once more, then cache".

### The check-and-reserve is serialized; the spending is not

The cache check is a read, then a decision, then a paid call, and only the final
`upsertClaim` was ever inside a lock. Two overlapping executions — the hourly
trigger and a manual run — would both read the same stale fingerprints, both
decide to enrich, and both spend before either write became visible.

Serializing the whole tick is not an option: it makes paid LLM calls, and holding
the script lock across them would starve webhook ingest for minutes, which is
precisely what `docs/specs/024`'s lock discipline exists to prevent. So the tick
takes the lock only long enough to check and set an in-flight marker, then
releases it and does the slow work outside.

The marker carries a TTL equal to the Apps Script execution cap rather than
relying solely on being released, so a tick killed mid-flight cannot wedge the
sync until somebody notices. A failure of the reservation itself degrades to
running the tick, not to skipping it: the reservation is an optimisation against
duplicate spend, and a CacheService outage must not stop claims syncing.

### A miss is cached, a failure is not

The property lookup has three outcomes, and they cache differently:

- **Found** (`source_url` present) — cached until the address fingerprint changes.
- **Miss** (the call returned, nothing sourced) — `property_lookup_at` is
  written and the address is not re-searched for 7 days. Without this, an
  address the search genuinely cannot resolve is re-searched every hour forever,
  which is the same defect in miniature.
- **Failed** (the call threw) — no cache marker is written, so the next tick
  retries.

This is why `lookupPropertyDetailsSafely` returns `{ values, failed }` rather
than the bare values. Collapsing "searched, found nothing" and "the call never
completed" into the same empty result would have cached a 402 as a miss and
suppressed the lookup for a week after credits were restored.

A failed lookup also leaves the row's existing property values alone rather than
blanking them — unless the address itself changed, in which case those values
describe a different house. Wiping good data on a transient failure only buys
the same lookup again next tick.

## Consequences

- Jobs that were silently looping now reach `failed` and notify. Expect a burst
  of failure notifications on first deploy: that is the defect becoming visible,
  not a regression.
- A job carrying stale `attempts` from before this change may reach `failed` one
  or two laps early. Attempts are per-stage and reset on the next clean handoff,
  so this is bounded to jobs already in flight, and each one is visible in the
  failure notification.
- `llm_calls` counts a call from the moment it is issued, not once it returns. A
  call that throws after its HTTP request is away has still been billed, and
  telemetry that under-reports precisely when things fail is worse than none.
- The tick reads the Claims tab once and hands those rows to
  `refreshClaimCandidatesCache`, which otherwise reads the whole tab again for
  the same data.
- `calendar_sync.tick_end` carries `llm_calls` and `llm_calls_skipped`. On a
  steady calendar the second tick over the same events reads `llm_calls: 0`;
  anything else means a fingerprint input is changing every hour and is worth
  investigating.
- Calendar events edited only in fields outside the fingerprint (attendees, for
  instance) skip both calls. That is correct — neither call reads those fields —
  and `calendar_fields` still carries the verbatim description, rewritten every
  tick from the event itself.

## Alternatives considered

**A `resume_status` column on the Jobs tab.** Rejected: the status vocabulary
already expresses the stage a job belongs to, and a second source of truth for
"where does this resume" is one more thing to keep in agreement.

**Re-reading the Jobs row inside `failJob` for the attempt count.** Rejected: a
Sheet round trip inside the lock, and still racy against a concurrent write.
`leaseJob` already computed the number.

**A timestamp-only calendar cache (skip anything enriched in the last N hours).**
Rejected: it caches a stale answer after a real edit, and still re-searches an
unchanged event once the window passes. The fingerprint covers every input each
call receives, so a changed input always re-runs and an unchanged one never does.

**A spend cap or budget alarm.** Worth doing, and deliberately not done here —
it would have made these two defects cheaper without making either of them stop.
