# Adjuster Stops Paying For Work It Has Already Done

**Status:** Draft
**Owner:** Adjuster MVP
**Linear:** _not yet filed_
**Last updated:** 2026-09-15

## Objective

Two independent defects make the adjuster pay, repeatedly, for results it
already has. A failed extraction rewinds the job to stage A, so every retry
buys a fresh paid ElevenLabs transcription of a recording that transcribed fine
the first time. And calendar sync re-runs both of its LLM calls for every event
in its window on every hourly tick, so the same ten calendar events were
enriched up to forty times each. Together they account for essentially all of
the $20 of OpenRouter credit spent to date and are still spending today. Make a
failed stage resume in place, and make calendar enrichment run once per change
instead of once per tick.

## Non-goals

- Changing what transcription does, which ASR vendors it calls, or how the
  master merge works. This spec changes only _when_ a stage is re-entered.
- Changing the drain loop, its 240-second budget, its 20-iteration cap, or the
  lock discipline in `docs/specs/024`. The loop is correct; it is being fed a
  job that never stops being re-queueable.
- Changing the n8n workflow, the Worker, or how the drain is invoked. The
  Cloudflare-524 / unpublished-workflow issue is separate and is not a code
  change in this repo.
- Changing the calendar sync window (`CALENDAR_SYNC_WINDOW_PAST_HOURS = 4`,
  `CALENDAR_SYNC_WINDOW_FUTURE_HOURS = 48`, `calendarSync.js:1`) or the tick
  frequency. Once enrichment is cached, neither drives cost.
- Changing what the property lookup or the calendar-field extraction _return_.
  Only whether they are called.
- Adding a spend cap or budget alarm. Worth doing; out of scope here.

## Business Rationale

OpenRouter credits reached $0 on 2026-09-15 at 10:37:35Z — `total_usage`
$20.005 against `total_credits` $20.00. Every LLM call since returns
`402 This request requires more credits`, and the pipeline is down.

From OpenRouter's activity API, cross-referenced against per-day event counts in
the `Raw` tab:

| day   | $     | requests | prompt tokens | calendar-sync calls | share |
| ----- | ----- | -------- | ------------- | ------------------- | ----- |
| 09-10 | 0.380 | 45       | 298K          | 10                  | 22%   |
| 09-11 | 0.890 | 48       | 589K          | 48                  | 100%  |
| 09-12 | 1.373 | 116      | 976K          | 114                 | 98%   |
| 09-13 | 2.610 | 252      | 1.85M         | 252                 | 100%  |
| 09-14 | 3.506 | 374      | 2.57M         | 344                 | 92%   |

Every charge is `openai/gpt-5.6-luna` at ~$0.0097/request, driven by **prompt
tokens** — the `:online` search results return as prompt context, and that
context is the bill. There is no separate web-search line item, so the only
lever is not making the call.

### Leak 1 — a failed extraction re-transcribes the call

Capture `retell-call_ae646da0e8d956f422b4dbd3f18` (756 seconds) was transcribed
through ElevenLabs **six times between 17:55Z and 18:21Z** and was still looping
when this spec was written. One lap, from the `Raw` tab:

```
18:00:24  job_leased  stage=transcribe attempt=1
18:00:43  source_finished  source=elevenlabs ok=true latency_ms=14126   ← paid
18:01:41  source_finished  source=qwen ok=false status=402
18:01:45  master_transcript.call_failed  402
18:01:47  pass_complete  →  status=transcribed
18:01:49  job_leased  stage=extract attempt=1
18:01:51  openrouter 402
18:01:52  job_failed  {attempts: 0, next_status: "pending"}             ← rewind
18:01:54  job_leased  stage=transcribe attempt=2
18:02:14  source_finished  source=elevenlabs ok=true latency_ms=16873   ← paid again
```

ElevenLabs is billed per pass and is **not** the exhausted vendor, so this is
spending real money right now. It also masks the failure: the drain reports
iterations and advances, so from n8n the job looks like it is progressing.

The defect is one mistake in four places.

**1. `failJob` always rewinds to stage A** (`runner.js:648`) — it has no idea
which stage failed:

```js
function failJob(job, errorMessage) {
  var attempts = Number(job.attempts || 0)
  var status = attempts >= 3 ? 'failed' : 'pending'
```

`pending` is the queue `getOldestPendingJob()` reads, so a failed extraction
re-enters transcription.

**2. The attempt counter resets every lap** (`runner.js:355`). The clean handoff
writes `attempts: 0`, and its comment states the intent — _"attempts resets on a
clean stage handoff so stage B gets its own retry budget rather than inheriting
whatever stage A spent out of the same 3."_ That intent is right. The line is
only wrong because defect 1 makes stage A run again on a stage B retry.

**3. `failJob` reads a stale count.** `advanceOldestPendingJob` snapshots
`picked.job`, `leaseJob` then writes `attempts + 1` to the sheet, and the
`catch` hands `failJob` the _pre-lease snapshot_. `upsertJob(capture_id, {
status, error })` never writes an attempt count back. This is why the log says
`attempts: 0` on the fifth attempt and why the Jobs row still read
`attempts = 0` after six laps.

**4. `reclaimStuckJobs` rewinds too** (`jobs.js:281`) — every expired lease goes
to `pending`, including `extracting` and `generating`.

Defects 2 and 3 mean the `attempts >= 3` guard can never fire; defect 1 means
what it would have guarded is the expensive path.

### Leak 2 — calendar sync re-enriches unchanged events hourly

`syncEventToClaim` (`calendarSync.js:247`) makes two paid calls before it looks
at anything already stored:

```js
var details = extractCalendarFields(event.getTitle(), event.getLocation(), description)
var propertyLookup = lookupPropertyDetailsSafely(
  resolveFullAddressText(event.getLocation(), description),
)
```

No cache, no dirty check. The window spans 52 hours and the tick is hourly, so
each event is re-enriched about forty times before it ages out. In the 48 hours
to 2026-09-15 that produced **278 property lookups across 10 distinct events**
(40× / 40× / 40× / 28× / 27× / 25× / 23× / 22× …), plus a matching
`extractCalendarFields` call each time.

Seven of the eight worst offenders already held complete data — year built,
beds, baths, square footage and a source URL — on their Claims row. It
re-searched them anyway to write back identical values. Cost on 09-14 was ~49
calls per calendar event per day, about **$0.46/day per event, indefinitely**,
for facts about a house that do not change.

This began at the first `calendar_sync.tick_start`, 2026-09-10 19:36Z. Ticks are
flat at 24/day, so cost scales purely with how full the calendar is: at the 7
events of 09-14 it was ~$3.20/day, and at 20 events it would be ~$9/day.

## Architecture

### Decision: a stage failure returns the job to that stage's own queue

Status _is_ the queue. `advanceOldestPendingJob` picks `transcribed` first and
`pending` second, so the resume status is the choice of stage:

| Failing stage | Leased status              | Resume status | Re-runs      |
| ------------- | -------------------------- | ------------- | ------------ |
| transcribe    | `matching`, `transcribing` | `pending`     | stage A      |
| extract       | `extracting`, `generating` | `transcribed` | stage B only |

`advanceOldestPendingJob` already computes `stage` to pick a handler; it passes
the same value to `failJob`. No new state and no new column — the status
vocabulary already expresses this and was simply never used on the failure path.

With this in place the `attempts: 0` reset at `runner.js:355` becomes correct as
written: it runs only on a genuine forward handoff, once per real transcription.
It stays, with its comment extended to say why it is now safe.

### Decision: the attempt count is threaded, not re-read

`leaseJob` already computes the authoritative attempt number when it writes the
lease. It returns that number, `advanceOldestPendingJob` holds it, and hands it
to `failJob`, which persists it alongside `status` and `error`.

Re-reading the row inside `failJob` costs another Sheet round trip inside the
lock and can still race. Threading is exact, and it makes the
`runner.job_failed` line truthful — the untruthful line is a large part of why
this went unnoticed.

### Decision: a billing or auth failure fails the job immediately

`401`, `402` and `403` cannot succeed on a retry. The HTTP layer already knows
this: `callOpenRouter`'s `retryable` check is `status === 429 || status >= 500`,
so it correctly does not retry them in-process. The job layer then retries them
anyway, three times. A stage throwing a non-retryable vendor error goes straight
to `failed` and notifies.

### Decision: calendar enrichment is keyed on a content fingerprint

Both calls are pure functions of their inputs, and the inputs live on the event:

| Call                    | Input                        | Re-run when             |
| ----------------------- | ---------------------------- | ----------------------- |
| `extractCalendarFields` | title, location, description | any of the three change |
| `lookupPropertyDetails` | resolved full address text   | the address changes     |

The Claims row stores a fingerprint of each input. On a tick, `syncEventToClaim`
compares the event's current fingerprint against the stored one and skips the
call when they match, reusing the values already on the row.

Three new columns, appended to `CLAIMS_CALENDAR_COLUMNS` (`calendarSync.js:8`).
`ensureClaimsColumns()` already runs at the top of every tick
(`calendarSync.js:192`) and adds missing columns in place, so this needs no
migration and no backfill: the first tick after deploy writes the columns, that
tick's lookups populate them, and every later tick skips.

| Column                         | Holds                                        |
| ------------------------------ | -------------------------------------------- |
| `calendar_fingerprint`         | hash of `title \| location \| description`   |
| `property_address_fingerprint` | hash of the resolved full address text       |
| `property_lookup_at`           | ISO timestamp of the last _completed_ lookup |

`property_source_url` already distinguishes a hit from a miss, so no fourth
column is needed.

### Decision: a miss is cached, a failure is not

One of the ten events (`5lr1ur0kukiuvv4vthvu4ojkk5@google.com`) has an address
the search genuinely cannot resolve — it returns `EMPTY_PROPERTY_LOOKUP` with no
`source_url`. Without a negative cache that address is re-searched every hour
forever, which is the same defect in miniature.

But `lookupPropertyDetailsSafely` currently swallows a thrown error and returns
the same `EMPTY_PROPERTY_LOOKUP`, making "searched, found nothing" and "the call
failed" indistinguishable. Caching a 402 as a miss would suppress the lookup for
a week after credits are restored. So the wrapper must report which happened:

- **Found** (`source_url` present) — cache until the address fingerprint changes.
- **Miss** (call returned, no `source_url`) — write `property_lookup_at` and do
  not retry for 7 days.
- **Failed** (call threw) — write no cache marker; retry on the next tick.

A single read of `getClaims()` per tick, mapped by `claim_id`, serves every
event's cache check — one Sheet read per tick, not one per event.

### ADR

Two decisions here outlive this spec and take one ADR at the next free number in
`docs/adr/`, titled _"Repeat work is a bug: stages resume in place and
enrichment is fingerprinted"_. Record the status-is-the-queue mapping, the rule
that no failure path may rewind a job past work that already succeeded, and the
found/miss/failed caching contract.

## Implementation Phases

### Phase 1 — Stop the re-transcription (PR-1 … PR-3)

Leak 1 is bleeding a vendor that still has credit, so it lands first. Defects 1,
2 and 3 are a single edit surface and ship together: shipping the counter
without the routing would fail jobs after three laps _and_ still buy three
transcriptions, while looking fixed.

### Phase 2 — Stop the re-enrichment (PR-4, PR-5)

Leak 2 costs nothing while credits are at zero — every call 402s — but resumes
the moment the account is topped up. It must land before the top-up.

## PR list

### PR-1 🟡 A failed stage resumes at its own stage, with a real attempt count

- **Domain:** backend
- **Scope:** `apps/adjuster/src/runner.js` — `leaseJob` returns the attempt
  number it wrote; `advanceOldestPendingJob` threads `stage` and that number
  into `failJob`; `failJob` maps stage → resume status (`transcribe` →
  `pending`, `extract` → `transcribed`) and persists `attempts`. The
  `attempts: 0` reset at `runner.js:355` is unchanged, comment extended. Tests
  in `tests/unit/adjuster/runner.test.ts`.
- **Acceptance:** with extraction stubbed to throw on every call, a job entering
  at `pending` runs the transcription stage **exactly once** across three
  extraction attempts (asserted by call-count spy), the Jobs row's `attempts`
  reads 1, 2, 3 on successive laps, and the job lands on `failed` with
  `notifyJobFailed` called once. A transcription-stage failure still resumes at
  `pending`.
- **Gate:** none

### PR-2 🟡 An expired lease resumes at its own stage

- **Domain:** backend
- **Scope:** `apps/adjuster/src/jobs.js` — `reclaimStuckJobs` maps
  `matching`/`transcribing` → `pending` and `extracting`/`generating` →
  `transcribed` instead of writing `pending` unconditionally. The
  `attempts >= 3` → `failed` branch is unchanged. Tests alongside the existing
  reclamation coverage.
- **Acceptance:** a row at `extracting` with an expired `lease_until` and
  `attempts = 1` reclaims to `transcribed`; a row at `transcribing` under the
  same conditions still reclaims to `pending`; either at `attempts >= 3` still
  goes to `failed`.
- **Gate:** none

### PR-3 🟢 A billing or auth failure does not consume a retry budget

- **Domain:** pure
- **Scope:** a predicate recognising non-retryable vendor failures (HTTP 401,
  402, 403 in the thrown message) plus its wiring in `failJob`. Tests for the
  predicate and for the routing.
- **Acceptance:** a stage throwing `OpenRouter request failed: 402 …` moves the
  job to `failed` on the first attempt with the vendor message preserved in
  `error`, and `notifyJobFailed` is called; a stage throwing a 500 still
  consumes one attempt and resumes at its own stage.
- **Gate:** none

### PR-4 🟢 The fingerprint and the re-enrichment decision, as pure functions

- **Domain:** pure
- **Scope:** a fingerprint helper over the event's text inputs and a
  `shouldReenrich(stored, current, now)` decision returning which of the two
  calls a tick needs. No wiring — `syncEventToClaim` is untouched by this PR.
  Tests in `tests/unit/adjuster/calendarSync.test.ts`.
- **Acceptance:** unchanged inputs against a stored row carrying a
  `property_source_url` return "skip both"; a changed description returns
  "re-extract only"; a changed address returns "re-lookup only"; a stored miss
  (`property_lookup_at` set, no `source_url`) within 7 days returns "skip", and
  older than 7 days returns "re-lookup"; an absent stored row returns "run
  both".
- **Gate:** none

### PR-5 🟡 Calendar sync consults the cache before it spends

- **Domain:** backend
- **Scope:** `apps/adjuster/src/calendarSync.js` — append
  `calendar_fingerprint`, `property_address_fingerprint` and
  `property_lookup_at` to `CLAIMS_CALENDAR_COLUMNS`; read `getClaims()` once per
  tick and pass the matching row into `syncEventToClaim`; gate both LLM calls on
  PR-4's decision, reusing the stored values when skipped;
  `lookupPropertyDetailsSafely` distinguishes found / miss / failed so a thrown
  call writes no cache marker. Per-event `calendar_sync.enrichment_skipped`
  logging and `llm_calls` / `llm_calls_skipped` counters on
  `calendar_sync.tick_end`.
- **Acceptance:** two consecutive ticks over the same unchanged event make the
  LLM calls on the first tick and **zero** on the second, with the Claims row's
  property fields unchanged between them; editing the event description
  re-triggers `extractCalendarFields` but not the property lookup; a property
  lookup that throws leaves `property_lookup_at` unwritten and is retried on the
  next tick; `calendar_sync.tick_end` reports the skip counts.
- **Gate:** none

## Edge Cases & Risk

| Risk                                                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A job already at `transcribed` with stale `attempts` from before the fix fails sooner than three fresh tries | M          | L      | Attempts are per-stage and reset on the next clean handoff; worst case one job reaches `failed` early and is visible in the failure notification                                                             |
| Extraction retried at `transcribed` reads transcription output a failed lap half-wrote                       | L          | M      | `runTranscriptionStage` writes its columns in one `upsertJob` after the pass completes; a failed pass writes nothing. Pinned by a test asserting a failed extract leaves the transcription columns untouched |
| `generating` maps to `transcribed` but docgen may depend on state extraction wrote                           | L          | M      | Confirm in PR-2 whether extraction's outputs are on the row before `generating` is entered; if not, the mapping is still correct because extraction is idempotent over the transcript                        |
| Fail-fast on 402 means a mid-drain top-up no longer auto-recovers in the same pass                           | M          | L      | Correct behaviour: the job is `failed`, visible and replayable. Recovery becomes a deliberate replay rather than an accident of a retry budget                                                               |
| The loop is currently masking how many jobs are genuinely stuck                                              | M          | M      | After PR-1 those jobs reach `failed` and notify. Expect a burst of failure notifications on first deploy — the defect becoming visible, not a regression                                                     |
| A stale fingerprint suppresses a lookup that should have re-run                                              | L          | M      | The fingerprint covers every input the call receives, so a changed input always changes the hash. Pinned by PR-4's tests per input field                                                                     |
| Calendar events edited only in fields outside the fingerprint (e.g. attendees) silently skip                 | M          | L      | Correct: neither call reads those fields. `calendar_fields` still carries the verbatim description, rewritten every tick from the event itself                                                               |
| The 7-day negative TTL hides a property that becomes findable sooner                                         | L          | L      | Bounded and self-healing; an address correction changes the fingerprint and re-runs immediately                                                                                                              |
| Adding three Claims columns shifts column order for anything reading by index                                | L          | M      | `ensureClaimsColumns` appends, and every reader goes through `getSheetRows`' header map. PR-5 adds a test that a row written before the columns existed still reads                                          |

## Acceptance Criteria

- [ ] With extraction stubbed to always throw, the transcription stage runs
      exactly once per job — asserted by a call-count spy, not by inspection
- [ ] `attempts` in the Jobs row increments across retries and the job reaches
      `failed` on the fourth entry
- [ ] `runner.job_failed` logs the same attempt number written to the row
- [ ] An expired `extracting` lease reclaims to `transcribed`
- [ ] A 402 fails the job on the first attempt
- [ ] A transcription-stage failure still resumes at `pending`
- [ ] A second tick over an unchanged calendar event makes zero LLM calls
- [ ] A changed description re-extracts without re-running the property lookup
- [ ] A thrown property lookup writes no cache marker and retries next tick
- [ ] `calendar_sync.tick_end` carries `llm_calls` and `llm_calls_skipped`
- [ ] The profile's `verify.full` command passes
- [ ] ADR filed in `docs/adr/`
- [ ] No hardcoded secrets

## Human verify

- [ ] In the `Raw` tab, filter `transcription.source_finished` to
      `source=elevenlabs` for the test call's `capture_id` — exactly one row,
      not one per drain.
- [ ] The Jobs row for the test call shows `attempts` advancing on retries
      rather than sitting at 0.
- [ ] Two consecutive `calendar_sync.tick_end` lines: the second reports
      `llm_calls: 0` with `llm_calls_skipped` equal to the event count.
- [ ] `openrouter_web_search.response_summary` appears at most once per calendar
      event per day in the `Raw` tab, not once per hour.
- [ ] OpenRouter's activity for the day after deploy shows request volume in the
      tens, not the hundreds.
