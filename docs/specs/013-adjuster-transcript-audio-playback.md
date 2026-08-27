# Adjuster Transcript Audio Playback

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-08-27

## Objective

In the review web app from
[012-adjuster-review-webapp.md](012-adjuster-review-webapp.md), let the
adjuster play the actual moment of the call each `source_span` quote came
from, instead of only reading the quoted text. Each snippet card gets a play
button that seeks the call recording to just before the relevant words and
stops just after; each section gets a "play section" option covering every
snippet in it. This spec depends on 012's UI shell (section list, snippet
cards) for its page structure — it adds a timestamp resolver and an audio
player, not new page structure — but it also extends 012's ingest code path
(Phase 1 of 012) with timestamp resolution and recording upload, so it isn't
purely a UI-only addition on top of an otherwise-finished 012. See
Implementation Phases for how that ingest-path work is sequenced to avoid
touching it twice.

## Non-goals

- Waveform visualization, scrubbing UI, or a full transcript-with-playhead
  view (Descript-style editing). A single play/stop per snippet is the whole
  interaction.
- Editing the transcript or correcting ASR mistakes from this UI.
- Re-running ASR with different settings to get timestamps — the existing
  ElevenLabs word-level output is used as-is.
- Realtime/live playback during a call. This is review-time playback of a
  completed, recorded call only.
- Multi-recording jobs (e.g. a claim built from more than one call). Assume
  one recording per job, matching the current pipeline's scope.

## Business Rationale

012 gives the adjuster the quoted text next to each field, which already cuts
review time significantly. But transcribed text loses tone, hesitation, and
exact wording nuance that can matter for a coverage/liability-sensitive field.
Letting the adjuster hear the 5-10 seconds of the actual call, one click away,
turns "does this quote actually support what I'm about to accept" from a
judgment call on ASR output into a judgment call on what was actually said.

## Architecture

### Prerequisite: ElevenLabs becomes a required dependency, not a silent fallback

Today's pipeline doesn't guarantee ElevenLabs' timestamped transcript is even
present for a given job. `runner.js` feeds both extraction and validation
from `resolveExtractionTranscript(job)`, and which transcript that resolves
to depends on `job.extraction_input`: the live default is `'dograh'`
(`getMasterTranscriptMode()` defaults to `'shadow'`), which carries no
timestamp data at all — only the ElevenLabs call requests
`timestamps_granularity: 'word'`. If ElevenLabs' ASR call fails, the pipeline
today logs the vendor error and continues without it (per the "log the
vendor error body when an ASR source fails" fix already in this app) — a
deliberate silent-fallback-and-continue design for draft generation, since a
draft with fewer sources is still better than no draft.

Decision for this spec: **ElevenLabs moves from an optional source to a
required dependency of the core extraction path.** If ElevenLabs' ASR call
fails, the job fails (retries per the existing job-retry mechanism) rather
than silently proceeding without timestamp data — because a `source_span`
this spec can't attach a clip to is, from the adjuster's perspective, a
regression from today's text-only review, not a degraded-but-working state.

**This is a backwards-incompatible change to existing job-success behavior**
(per `.claude/CLAUDE.md`'s guidance on backwards-incompatible changes): jobs
that previously completed via Dograh-only fallback when ElevenLabs errored
will now fail instead. Ship and verify this as its own standalone phase
(Phase 0 below), decoupled from the rest of this feature, so its effect on
job success rate is visible on its own before the playback UI depends on it.

### The gap: `source_span` has no timestamp today

`transcription.js` already requests word-level timestamps from ElevenLabs
(`{ name: 'timestamps_granularity', value: 'word' }`) and saves the full word
array with per-word start/end to `transcript-elevenlabs-words.json`. But
`validate.js`'s `spanExistsInTranscript` checks `source_span` against a
_flattened, whitespace-normalized transcript string_ — it proves the text
exists, verbatim, somewhere in the transcript, but throws away _where_. By the
time a `source_span` reaches `adjuster_review_items` (012), that positional
information is gone.

### New component: snippet-to-timestamp resolver

With the prerequisite above, ElevenLabs' timestamped transcript exists for
every job — but `source_span`'s actual wording doesn't always come from
ElevenLabs. Under `master` mode, the merge selects each turn's wording from
whichever source (ElevenLabs/Qwen/Dograh) the merge model judged most
accurate for that turn, so a span drawn from a Qwen- or Dograh-won turn won't
literal-substring-match the ElevenLabs word array even though ElevenLabs
transcribed the same turn, on the same recording, at roughly the same time.
Since every source reads the same audio clip, the fix is to fall back to
*when* rather than insisting on exact-text match: if the words don't match,
use that turn's ElevenLabs-derived time range instead, and pad more
generously to absorb the timing slop between sources.

A pure function, `resolveSpanTimestamps(sourceSpan, turnIndex, words)`:

- `words` is the ElevenLabs word array (each entry has text + start/end, per
  `transcript-elevenlabs-words.json`'s existing shape), annotated with which
  turn each word belongs to. Turn boundaries must be threaded through from
  wherever the master merge already tracks them and preserved as an explicit
  field on each word/turn — not left to fall out of whitespace collapsing,
  since `validate.js`'s `normalizeWhitespace` (`\s+` → single space) already
  flattens newlines and would erase turn boundaries if they were relied on
  implicitly. `turnIndex` is the turn `source_span` came from, threaded
  through from the same merge output.
- **Reconstruction**: concatenate `words`' text the way `transcription.js`'s
  `renderDiarizedTurns()` already does elsewhere in this codebase — raw
  concatenation (`current.text += text`, no synthetic space inserted between
  words), then whitespace-normalize the result. ElevenLabs' word entries
  already carry their own spacing internally (`type: word|spacing` per
  ElevenLabs Scribe's format); joining with a synthetic single space between
  every word would produce a string that doesn't match the actual haystack
  wherever a word doesn't need a separating space, and silently shift the
  computed character offsets.
- **Tier 1 (exact match)**: locate `source_span` as a substring of the
  reconstructed, normalized word text. If found, return `{ startMs, endMs }`
  from the first and last matched word's `start`/`end`. This is the precise
  case — pad by a configurable default of **1.5s** on each side.
- **Tier 2 (turn-position fallback)**: if no exact substring match (the
  span's wording came from a non-ElevenLabs source for that turn), use the
  min `start` / max `end` across all ElevenLabs words tagged with
  `turnIndex`. This is the imprecise case — pad by a wider configurable
  default of **2.5s** on each side, since the clip boundary is approximate.
- Both tiers clamp the result to `[0, recordingDurationMs]`.
- Returns `null` (not a thrown error) if `turnIndex` itself can't be resolved
  to any ElevenLabs words — e.g. a turn ElevenLabs never captured at all.
- This resolver runs once, in Apps Script, as part of the same ingest-path
  change described in Phase 1 below — not client-side, since the word array
  only exists in Apps Script's Drive-stored transcript files today. The
  resolved `start_ms`/`end_ms` (already padded, already tier-resolved) get
  added to the payload and stored on `adjuster_review_items`.

### Schema change

Extend `adjuster_review_items` (012) with two nullable columns:
`clip_start_ms integer`, `clip_end_ms integer`. Null when resolution fails
(e.g. ASR word-level data wasn't available for that call) — the play button
simply doesn't render for that item.

Section-level "play section": computed client-side as
`min(clip_start_ms)` to `max(clip_end_ms)` across the section's items with
non-null clips. No new column needed.

### Serving the recording

Call recordings are currently downloaded locally (`run_local.sh`, the manual
test-injection flow for Dograh calls) — not yet in any browser-reachable
location. This spec adds: upload the recording to Supabase Storage, keyed by
job id, at the same point Apps Script POSTs to `adjuster-review-ingest`
(Phase 1 of 012). Bucket should be private with signed URLs issued per
authenticated request, consistent with 012's RLS-scoped, single-operator
access model — not a public bucket, since recordings contain the same
PII/financial detail as the transcript.

### Player component

A snippet card (012) that has a non-null clip range renders a play button.
Implementation: a shared `<audio>` element per section (not one per snippet —
avoids N simultaneous audio elements), `currentTime` set to the clip's padded
start on play, a `timeupdate` listener that pauses playback once
`currentTime >= endMs`. "Play section" uses the same element with the
section's min/max range. No new library needed — native `HTMLAudioElement`
covers seek-and-stop-at-boundary.

## Implementation Phases

### Phase 0 — ElevenLabs required-dependency prerequisite

- `runner.js`/`transcription.js` change: an ElevenLabs ASR failure fails the
  job (existing retry mechanism) instead of logging and continuing without
  it.
- Ship and verify standalone, ahead of the rest of this spec — this is a
  backwards-incompatible change to existing job-success behavior (see
  Architecture above) and needs to be observed on its own before Phase 1
  builds on the assumption that ElevenLabs data is always present.
- Unit tests: failure path now surfaces as a job failure, not a silent
  continue.

### Phase 1 — Ingest path extension: timestamps + recording upload

Both pieces below touch the same Apps Script ingest code path (012's
ingest-POST builder) — do them together, in one change, rather than as two
separate edits at different times, so that code path is only revisited once
for this spec.

- `resolveSpanTimestamps` as a pure, unit-tested function in Apps Script
  (co-locate with `validate.js` or a new `transcriptTiming.js`), including
  turn-index threading from the master merge output.
- Wire into 012's ingest POST: for each review-eligible field, attempt
  tier-1/tier-2 resolution against the job's word array; include
  `clip_start_ms`/`clip_end_ms` (or nulls) in the payload.
- Upload the recording to Supabase Storage as part of the same ingest call,
  private bucket, keyed by job id.
- Edge Function or RLS-backed signed-URL issuance for the authenticated
  adjuster to fetch the recording.
- Migration: add `clip_start_ms`, `clip_end_ms` to `adjuster_review_items`.
- Unit tests: exact-match (tier 1) resolution, turn-position fallback
  (tier 2) resolution, reconstruction fidelity (raw-concatenate-then-
  normalize matches the actual haystack — this is the real risk, not ASR
  punctuation/casing variance, since any `source_span` reaching this
  resolver has already passed `spanExistsInTranscript`'s exact,
  whitespace-normalized check by construction), no-match-at-all (returns
  null, never throws — resolution failure must never block the rest of the
  ingest payload); recording upload path contract; signed URL issuance
  authorization.

### Phase 2 — Player UI

- Play button on snippet cards with a non-null clip range; "play section"
  control at the section level.
- Shared `<audio>` element per section, seek/stop-at-boundary logic.
- Unit tests: boundary computation (padding, clamping to recording duration),
  section range aggregation (min/max across items).

## Edge Cases & Risk

| Risk                                                                                                                                  | Likelihood | Impact | Mitigation                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source_span` text matches multiple locations in the transcript (repeated phrase)                                                     | L-M        | M      | Take the first match; log an ambiguous-match warning rather than guessing — a slightly-off clip is recoverable by the adjuster reading the quote anyway, a thrown error is not |
| Job fails outright because ElevenLabs' ASR call errors (Phase 0's backwards-incompatible change) | M | H | This is the intended tradeoff (see Architecture), but track job-failure-rate before/after Phase 0 ships, standalone, before Phase 1 depends on it |
| Tier-2 (turn-position) fallback used for a large fraction of spans — clip precision degrades broadly, not just per-item | M | M | Log tier-1 vs. tier-2 usage rate per job; if tier-2 dominates in practice, that's a signal the merge is favoring non-ElevenLabs wording often enough to revisit, not just an edge case |
| Turn boundary tracking breaks or isn't threaded through the merge correctly, causing tier-2 to select the wrong turn's word range | L | M | Unit-test turn-index threading explicitly; resolver returns null rather than guessing if `turnIndex` can't be resolved to any words |
| Padding pushes start below 0 or end past recording length                                                                             | M          | L      | Clamp to `[0, durationMs]`                                                                                                                                                     |
| Recording upload fails or is slow for long calls                                                                                      | L          | M      | Ingest proceeds without blocking on the upload; clip playback simply unavailable until upload completes (async, retried)                                                       |
| Signed URL exposes recording audio (containing PII) beyond intended access window                                                     | L          | H      | Short-lived signed URLs generated per request, not stored/cached long-term; private bucket, never public                                                                       |

## Acceptance Criteria

- [ ] Phase 0 shipped and verified standalone: an ElevenLabs ASR failure
      fails the job instead of silently continuing without timestamp data;
      job-failure-rate impact observed before Phase 1 begins
- [ ] Migration adds `clip_start_ms`/`clip_end_ms` to `adjuster_review_items`,
      applied and tested locally
- [ ] `resolveSpanTimestamps` unit-tested against tier-1 exact match, tier-2
      turn-position fallback, reconstruction fidelity (raw-concatenate-then-
      normalize, not synthetic-space-joined), and no-match-at-all
- [ ] Ingest payload includes resolved (tier-resolved, padded, clamped) clip
      range per review item, or null without failing the rest of the payload
- [ ] Recording uploaded to a private Supabase Storage bucket, accessible only
      via short-lived signed URL to the authenticated adjuster
- [ ] Timestamp resolution and recording upload land as a single change to
      012's ingest code path, not two separate later edits
- [ ] Snippet cards with a non-null clip range show a play button that seeks
      to the padded start and stops at the padded end
- [ ] Section-level "play section" control plays the min-to-max range across
      that section's clips
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass
- [ ] No hardcoded secrets — Storage bucket access and signed-URL issuance
      configured per this repo's existing auth/env conventions
