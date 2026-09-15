# ADR 013 — The Transcription Pass Is Idempotent Over Its Own Inputs

**Status:** Accepted
**Date:** 2026-09-15
**Owner:** CareerSystems / adjuster
**Related:** docs/adr/012-repeat-work-is-a-bug.md, docs/specs/027-adjuster-stop-paying-for-repeat-work.md

---

## Context

ADR 012 stopped the pipeline from re-entering stage A on a failure. It did not
make stage A safe to enter twice. `runTranscriptionPass` called
`transcribeInParallel` unconditionally: its only early exits were
`MASTER_TRANSCRIPT_MODE === 'off'`, a non-voice source, and a missing
`audio_drive_id`. Nothing consulted the Drive artifacts it had already written.

So the button was still live. Writing `pending` into a `done` or `failed` row by
hand — the obvious way to retry a job from the Jobs tab — bought a fresh
ElevenLabs pass, a fresh Qwen pass and a fresh long-context merge over a
recording that had already been transcribed. `attempts` offered no protection:
`advanceOldestPendingJob` leases and runs without consulting it, and the guard
lives only on the failure path. A row that had exhausted its attempts, set back
to `pending`, paid in full and then reset `attempts` to 0 on the clean handoff.

Stage A is not the only way in, either. Anything that legitimately returns a job
to `pending` — a reclaimed stage A lease, a replayed job, an operator retry — was
paying the same bill.

## Decision

### The reuse key is a fingerprint of the ASR inputs, not the existence of artifacts

The obvious guard is "artifacts exist, skip". It is wrong, and wrong in the
expensive direction: it would break the main legitimate reason to re-transcribe.

`buildKeyterms` derives the ASR bias terms from the matched claim, the glossary
and `ADJUSTER_NAME`, and those terms are passed to **both** ASR calls. Correcting
a claim match — the case where re-running stage A is exactly right, because the
first pass was biased toward the wrong insured, address and carrier — changes
nothing about which artifacts exist. An existence check would serve the bad
transcription back forever.

So `transcription_fingerprint` covers everything the calls actually read:

| Input                                             | Why it is in the fingerprint                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `audio_drive_id`                                  | A different recording is a different call                                         |
| keyterms                                          | They bias both ASR calls; a corrected claim match changes only these              |
| `job.transcript`                                  | The voice platform's own transcript is a merge source                             |
| `MASTER_TRANSCRIPT_MODE`                          | shadow/live decides `extraction_input`, which a reused pass hands back            |
| both ASR model ids                                | A model bump must re-transcribe, not serve the previous model's result            |
| `MASTER_TRANSCRIPT_MODEL`, `OPENROUTER_FALLBACKS` | The cached result includes the merge, so the merge's model is part of the key     |
| claim content, glossary term **and definition**   | `formatClaimBlock` and `formatGlossary` render both into the merge prompt in full |

Keyterms are not a proxy for the merge's view of the claim and glossary:
`sanitizeKeyterm` caps a term at 5 words and the list at 1000, and a glossary
definition reaches the merge prompt without reaching the keyterms at all.

The claim is fingerprinted by its **content**, not by the rendered prompt block,
and `_rowIndex`, `property_lookup_at`, `calendar_fingerprint` and
`property_address_fingerprint` are excluded. `formatClaimBlock` serializes every
key on the row, so a faithful hash of the prompt would re-buy two ASR passes and
a merge every time a calendar tick ran a property lookup or a row moved up the
sheet — the same defect in a new place. Those four are bookkeeping the merge
gains nothing from; everything the merge can actually reason about is in the key.

This is the same mechanism spec 027 applied to calendar enrichment, pointed at
the more expensive call. `fingerprintText` / `fingerprintParts` moved to
`util.js` so there is one implementation rather than two.

It also answers the objection raised when this was first proposed — that a guard
would add a second source of truth for "is this job past stage A" next to the
status that already says so. A content fingerprint makes no claim about the
job's position in the state machine. It answers a narrower question the status
cannot: _have the inputs to this specific paid call changed since we last paid
for it?_ Status still decides which stage runs. The fingerprint only decides
whether that stage has to buy its result again.

### A reuse is rejected when there is nothing meaningful to reuse

Two rejections, both falling through to a full pass:

- **`extraction_input` is blank.** `retranscribeJob` empties the transcription
  columns and re-queues stage A. Its fingerprint used to survive that, so the next
  pass matched, `storedTranscriptIsReadable` fell through to its voice-platform
  branch, and the blanks were handed back as a cache hit — silently swallowing the
  operator request that function exists to make. `retranscribeJob` now clears the
  fingerprint, and `reusableTranscription` independently refuses a row with no
  `extraction_input`, so neither half depends on the other being remembered.
- **The artifact is unreadable.** Below.

### A reuse is rejected when the artifact it vouches for is unreadable

A fingerprint match over a master transcript somebody deleted out of Drive would
hand extraction a file id that resolves to nothing. `storedTranscriptIsReadable`
checks the one artifact `resolveExtractionTranscript` will actually reach for,
branching on `extraction_input` exactly as that function does, and falls through
to a full pass when it cannot be read. Paying again beats silently producing a
draft from an empty transcript.

### Both operator entry points write under the script lock

`forceRetranscribe` and `retranscribeJob` read, log and write inside
`withJobLock`. Without it a drain already holding a lease on that row can finish
after the write and overwrite the cleared fingerprint with its own result, losing
the request with no trace. Both also call `ensureJobsColumns` first:
`transcription_fingerprint` postdates every Jobs sheet in existence and
`writeRowFields` throws on a header it cannot find, so without it the documented
override is unusable until the next drain happens to add the column.

### The override is explicit and named

`forceRetranscribe(captureId)` clears the fingerprint, returns the job to
`pending` and resets `attempts`. Run by hand from the Apps Script editor, the
same way `regenerateDraftFromArtifacts` and `reExtractFromArtifacts` are.

It exists because one real case is invisible to the fingerprint: the audio is the
same, the claim is the same, and the transcription is simply bad. That has to
stay possible, and it should be a deliberate, logged act rather than a side
effect of editing a cell. `transcription.force_requested` records who asked and
what the previous fingerprint was.

## Consequences

- Writing `pending` into a row by hand now re-runs stage A **without** paying for
  it, as long as the inputs are unchanged. The job walks forward to `transcribed`
  and stage B re-runs, which is almost always what the operator meant.
- The cheaper intents have cheaper entry points, and the table in the PR
  description is now the documented answer: `regenerateDraftFromArtifacts` for a
  re-render at zero vendor cost, `reExtractFromArtifacts` for a re-extract,
  status `transcribed` for stage B through the normal pipeline, and
  `forceRetranscribe` when the ASR itself has to run again.
- `transcription_fingerprint` is appended to `JOBS_TRANSCRIPTION_COLUMNS`.
  `ensureJobsColumns` runs at the top of every drain, so no migration: rows
  written before this carry a blank fingerprint, transcribe once more, and cache
  from then on.
- A reused pass appends no manifest run. The manifest describes passes that
  happened; `transcription.reused` records the ones that did not need to.

## Alternatives considered

**An "artifacts exist" check.** Rejected above: it breaks the corrected-claim
case, which is the main reason a human re-runs stage A on purpose.

**A `do_not_transcribe` flag on the row.** Rejected: it is a second source of
truth about the job's position in the machine — the thing ADR 012 argues
against — and it needs a human to set it correctly on every retry.

**Hashing the audio bytes rather than the Drive file id.** Rejected for now: it
means fetching the blob before deciding whether to skip, which is most of the
latency the skip is trying to avoid. `audio_drive_id` changes whenever the
recording is re-ingested, which is the case that matters. Worth revisiting if a
recording is ever mutated in place under a stable id.

**Two-level caching — reuse the raw ASR, re-run the merge.** Considered once the
merge inputs turned out to belong in the key. It would mean a changed merge model
or glossary definition costs one merge call rather than two ASR calls plus a
merge. Rejected for now on complexity: it needs the raw transcripts read back out
of Drive and re-gated, for a saving on a path that should be rare once the inputs
are stable. Worth revisiting if merge-model churn proves common.

**A global spend cap.** Still worth doing, still out of scope, now for the third
time. It would bound the damage from the next defect of this shape without
preventing any of the three found so far.
