# Dual Transcription Layer: Master Transcript

**Status:** Implemented — PR https://github.com/Blaze212/fractional/pull/27
**Owner:** Barton
**Last updated:** 2026-08-26

## Objective

Today a Dograh Notetaker call produces exactly one transcript (Dograh's own
real-time Deepgram stream), and every extracted field in the draft report is
validated against it. A real-time transcript of a cell-phone call from a truck
is the weakest link in the pipeline: it hears once, at streaming latency, over a
lossy codec, with no second pass. This spec adds a batch transcription layer that
runs two independent high-accuracy ASR models over the saved recording
(ElevenLabs Scribe v2 and Qwen3 ASR Flash via OpenRouter), then a single model
call that merges those two plus Dograh's real-time transcript, using the matched
claim as context, into one **master transcript**. The master transcript replaces
the Dograh transcript as the input to the existing `extractFields` call. Three
independent readings of the same audio, reconciled once, before anything is
extracted.

## Non-goals

- Any change to the Telnyx paths. The Record flow, single-stage AIGather, and
  guided flow keep their current single-transcript behavior untouched.
- Discarding Dograh's real-time transcript. It stays as a merge input, as the
  source of the call's turn structure, and as the last-resort fallback. It is
  ranked last on wording accuracy, not removed.
- Changing what `extractFields` extracts, the template, the enums, or the doc
  generation. The extractor's _input_ changes; its contract does not.
- Diarization as a deliverable. ElevenLabs' speaker IDs are an input to the merge
  step only; nothing downstream consumes `speaker_id`.
- Re-running extraction on already-`done` jobs automatically. A manual re-run
  entry point is specified; no automatic backfill.
- Streaming, real-time, or in-call use of the new transcripts. This is strictly a
  post-call batch pass.

## Business Rationale

Every field the extractor gets wrong is a field Brandon has to retype, and every
field it leaves as `[NEEDS INPUT]` because a `source_span` did not survive
validation is a field he has to write from scratch. Both failure modes trace back
to transcription quality more often than to the extraction prompt. Proper nouns
(insured names, carriers, street names) and trade terms (drip edge, pipe boot,
6/12 pitch) are exactly what a real-time model over a cell connection gets wrong,
and exactly what the report needs right.

The added cost is small enough not to be a factor. Per 10-minute call:
ElevenLabs Scribe v2 batch at $0.22/hr plus keyterm prompting at $0.05/hr is
about $0.045; Qwen3 ASR Flash at $0.000035/sec is about $0.021; the merge call is
a few cents. Call it $0.10 per call against a current running cost of roughly
$15/month at 12 to 15 calls a week. The constraint is Apps Script execution time,
not spend. See Architecture.

## Context: decisions already settled

**Scope is Dograh jobs only.** The pass runs when `source === 'dograh'` and
`audio_drive_id` is set. Telnyx-sourced jobs fall through unchanged.

**ElevenLabs is called directly, as a documented exception.** The project rule is
that model calls route through OpenRouter. ElevenLabs Scribe is not available
through OpenRouter's STT passthrough, and the two things this layer most needs
from it (speaker diarization and `keyterms` biasing) are ElevenLabs-native
parameters with no OpenRouter equivalent. This is the only direct-vendor model
call in the codebase and it is confined to one file. Qwen still goes through
OpenRouter, as does the merge call. An ADR records the exception.

**Source precedence is fixed: ElevenLabs, then Qwen, then Dograh.** One ordering
governs both which source wins a disagreement inside the merge and which
transcript is used when there is no usable merge. Dograh is last because it is a
single-pass real-time stream over a mobile codec and is expected to be the least
accurate on wording; it is still first and only on turn structure. Defined once
as `SOURCE_PRECEDENCE`, consumed everywhere.

**The merge model may not author new words.** It selects among the wordings the
three ASR sources actually produced; it never writes text that appears in none of
them. This is what keeps the existing `source_span` guardrail meaningful. See
"The verbatim constraint" below, which is the load-bearing design decision in
this spec.

**Transcription runs as its own pipeline stage.** Apps Script caps a single
execution at 6 minutes. Two ASR round-trips over a 10-minute recording plus a
long-context merge call plus the existing extract and docgen will not reliably
fit in one execution. Splitting on a job status makes each tick short and each
stage independently retryable.

**Artifacts are foldered per call.** Every output from one call (audio, the
three raw transcripts, the master, a run manifest) lands in a single Drive
folder named for that call. The draft Doc keeps landing in `DRAFTS_FOLDER_ID`
where Brandon already looks for it, with a link to its call folder in the doc
header.

## Architecture

### Runtime constraints that shape everything below

This is Google Apps Script (`apps/adjuster/src/`), not Node. Consequences:

- No `Promise`, no `async`. Parallelism is `UrlFetchApp.fetchAll(requests)`,
  which issues an array of requests concurrently and returns an array of
  responses. That is the mechanism for "call ElevenLabs and Qwen in parallel".
- `scripts/stt-transcribe.mjs` cannot be imported. Its model table, cost
  arithmetic, vocab handling, and OpenRouter request shape are ported by hand
  into `apps/adjuster/src/transcription.js`. The `.mjs` script stays as-is: it is
  the local A/B harness for comparing models, and remains useful for exactly that.
- 6-minute execution cap, 50MB `UrlFetchApp` payload cap.
- `writeRowFields` throws on any header it cannot find, so new Jobs columns must
  be created before first write (see `ensureJobsColumns` below).

### Pipeline stages

The runner becomes a two-stage machine driven by `status`:

```
dograh_notetaker webhook
  └─ status: pending          (unchanged, recording already copied to Drive)

runPipelineTick, stage A      lease as 'matching'
  ├─ matchClaim (+ LLM fallback)      ← unchanged logic, moved earlier
  ├─ ensure per-call Drive folder
  ├─ UrlFetchApp.fetchAll([ElevenLabs, Qwen])   ← parallel
  ├─ write both raws to the call folder
  ├─ merge call (OpenRouter, JSON schema)
  ├─ verbatim coverage gate
  ├─ write master to call folder + Jobs sheet
  └─ status: transcribed

runPipelineTick, stage B      lease as 'extracting'
  ├─ extractFields(master transcript)  ← input changed, contract unchanged
  ├─ validateFields(spans vs master)
  ├─ generateDoc
  └─ status: done
```

`processOldestPendingJob` becomes a dispatcher: it prefers the oldest
`transcribed` job over the oldest `pending` one, so work already in flight
drains before new work starts. One tick advances one job by one stage.

**Trigger interval:** the time-based trigger for `runPipelineTick` must be at
most every 5 minutes for a call to still reach a draft within the "finds it
waiting when he gets home" window. Confirm the current interval in the Apps
Script UI before deploying; if it is longer than 5 minutes, shorten it as part of
this change.

Matching moves from stage B into stage A because the merge call needs claim
context, and because the claim's proper nouns are the highest-value keyterms to
bias both ASR calls with.

### Stage A in detail

**1. Per-call Drive folder.** New `getOrCreateCallFolder(job)` in
`transcription.js`. Folder name: `<yyyy-MM-dd> <insured_last_name or 'unmatched'>
<capture_id>`, created under a new `CALL_ARTIFACTS_FOLDER_ID` script property.
The folder ID is stored on the job as `call_folder_id`, so the function is
idempotent: a retry reuses the folder rather than creating a second one.
`handleDograhNotetaker`'s existing `copyRecordingToDrive` call is changed to
target this folder instead of the flat `RECORDINGS_FOLDER_ID`; existing audio
already in the flat folder is left where it is (no migration).

**2. Keyterm / vocab list.** `buildKeyterms(claim, glossary)` returns a
deduplicated array of at most 1000 terms, each at most 50 characters
(ElevenLabs' documented limits), ordered highest-value first:

1. Claim proper nouns: `insured_last_name`, `address_line1`, `city`, `carrier`,
   `claim_number`.
2. `ADJUSTER_NAME`.
3. Every `term` from `loadGlossary()` (the existing `GLOSSARY_FILE_ID` trade
   glossary, the same list the extraction prompt already gets).

The same list is sent to both models, in each one's native parameter:
ElevenLabs takes `keyterms` as a JSON array field; Qwen takes a single
comma-joined string under `provider.options.alibaba.context`, matching what
`stt-transcribe.mjs` already does.

**3. Parallel ASR fan-out.** `transcribeInParallel(audioBlob, keyterms)` builds
two request objects and issues them through one `UrlFetchApp.fetchAll` call.

ElevenLabs request:

```
POST https://api.elevenlabs.io/v1/speech-to-text
Header: xi-api-key: <ELEVENLABS_API_KEY>
multipart/form-data:
  file                    the Drive audio blob
  model_id                scribe_v2
  language_code           en
  diarize                 true
  num_speakers            2
  timestamps_granularity  word
  keyterms                JSON array of the keyterm list
```

Response: `{ text, words: [{ text, start, end, speaker_id }], language_code,
audio_duration_secs }`. Both the flat `text` and the diarized `words` array are
kept; the merge step uses `words` to reconstruct speaker turns.

Qwen request (OpenRouter, same shape `stt-transcribe.mjs` already proves):

```
POST https://openrouter.ai/api/v1/audio/transcriptions
Header: Authorization: Bearer <OPENROUTER_API_KEY>
JSON: {
  model: "qwen/qwen3-asr-flash-2026-02-10",
  input_audio: { data: <base64>, format: "wav" },
  language: "en",
  provider: { order: ["alibaba"], allow_fallbacks: false,
              options: { alibaba: { context: "<comma-joined keyterms>" } } }
}
```

Response: `{ text, usage: { seconds, cost } }`.

Model IDs and the Qwen provider tag live in a `TRANSCRIPTION_MODELS` table at the
top of `transcription.js`, mirroring the `MODELS` table in the `.mjs` script, so
swapping a model is a one-line edit.

Failure handling is per-source and never fatal. `fetchAll` with
`muteHttpExceptions: true` returns non-2xx as ordinary responses; a transport
error throws for the whole batch, so the `fetchAll` call is wrapped and falls
back to two sequential `UrlFetchApp.fetch` calls so one dead vendor cannot take
out the other. Each source independently yields either text or empty.

**Source precedence.** One ordering governs every degraded path in this spec:
which source wins a disagreement inside the merge, and which source becomes the
master when there is no usable merge.

```
1. elevenlabs   batch, diarized, keyterm-biased
2. qwen         batch, keyterm-biased
3. dograh       real-time, streaming, least accurate on wording
```

It is defined once as `SOURCE_PRECEDENCE` in `transcription.js` and consumed by
both the merge prompt and the fallback logic, so the two can never drift apart.
Being the live in-call source is what puts Dograh first on structure and last on
wording: it is the only source that knows when the agent spoke, and the only one
that heard the call exactly once, at streaming latency, over the mobile codec.

`selectFallbackTranscript(sources)` returns the highest-precedence source that
produced non-empty text. Every "fall back" in this document resolves through that
function.

The count of successful sources drives what happens next:

| Sources available | Behavior                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3                 | Full merge.                                                                                                                                               |
| 2                 | Merge on the two available; log `transcription.degraded` with which source was lost.                                                                      |
| 1                 | Skip the merge entirely. Master = that source, whichever it is. `transcript_source` records both the source and the degradation. Job proceeds to stage B. |
| 0                 | Cannot happen. Dograh's transcript is already on the job before stage A runs, so the floor is always at least one source.                                 |

Both ASR calls get one retry on 429 or 5xx, reusing the existing
`OPENROUTER_RETRY_BACKOFF_MS` pattern from `openrouter.js`.

**4. The merge call.** New `apps/adjuster/src/llm/masterTranscript.js`.

`callOpenRouter` in `openrouter.js` is generalized to accept a `schemaName` and a
`logLabel` so the merge call reuses its retry, model-fallback, and dual-sink
logging rather than duplicating them. This is a mechanical refactor with no
behavior change to the extraction path; `extractFields` passes
`schemaName: 'extraction'` and gets exactly what it gets today.

Model: a new `MASTER_TRANSCRIPT_MODEL` script property, defaulting to the value
of `OPENROUTER_MODEL`. It is a separate property because the merge task is
long-context reconciliation, not structured extraction, and may want a different
model than extraction does.

System prompt covers, in this order:

- **What this audio is.** A cell-phone call placed by an independent insurance
  field adjuster driving away from a property inspection. He is dictating what he
  just saw, from a moving vehicle, to an automated intake agent that asks him
  questions section by section. Expect road and wind noise, a lossy mobile codec,
  clipped starts after each agent prompt, trade jargon, spelled-out numbers
  ("six twelve" for a 6/12 pitch), addresses, carrier names, and proper nouns.
- **What the three sources are, and their standing order.** ElevenLabs Scribe v2
  and Qwen3 ASR Flash are batch models that reprocessed the full saved recording
  after the call, with the claim's proper nouns and the trade glossary supplied
  as keyterms. Dograh is a real-time streaming transcript produced during the
  call: it has the turn structure right because it is the only source that knows
  when the agent spoke, and it is the least accurate on wording because it heard
  each phrase once, live, at streaming latency. Resolve every disagreement in
  this order, **ElevenLabs first, Qwen second, Dograh last**:
  - Where all three agree, use that wording.
  - Where ElevenLabs and Qwen agree and Dograh differs, they are right. Dograh
    disagreeing with both batch models is the expected case, not a signal.
  - Where ElevenLabs and Qwen disagree, prefer ElevenLabs unless the claim
    context or the trade glossary positively supports Qwen's reading. A name,
    address, carrier, or trade term that Qwen got right and ElevenLabs did not is
    exactly the case for overriding, and a real word in this domain beats one
    that is not. Dograh agreeing with Qwen is weak corroboration and is not on
    its own enough to overturn ElevenLabs.
  - Use Dograh's wording only where it is the sole source that produced
    intelligible text for that passage.
  - Record any passage where you had to override ElevenLabs, or where the choice
    was a genuine coin flip, in `contested_passages`.
- **The verbatim constraint** (below), stated as an absolute.
- **The output shape:** speaker-labeled turns, using Dograh's turn boundaries as
  the skeleton and the batch models' wording as the content.

User message sections: claim context (reusing `formatClaimBlock`), the trade
glossary (reusing `formatGlossary`), then the three transcripts each under a
labeled header stating its source and whether it is real-time or batch, with
ElevenLabs rendered as diarized turns from its `words` array.

Response format is `json_schema` with `strict: true`:

```json
{
  "turns": [{ "speaker": "adjuster" | "agent", "text": "string" }],
  "contested_passages": ["string"]
}
```

`contested_passages` holds the verbatim text of any passage where all three
sources disagreed and the choice was a genuine coin flip. These are logged and
appended to the run manifest; they are the signal for whether the keyterm list
needs extending. They do not block anything.

### The verbatim constraint

This is the decision the rest of the design hangs on.

`validateFields` today accepts a field only if its `source_span` is a verbatim
substring of the transcript. That is the codebase's single strongest
anti-hallucination guarantee: a field cannot reach the report unless the words
supporting it were actually in machine-transcribed audio. Feeding the extractor a
model-authored master transcript would quietly turn that guarantee into "the
extractor did not invent anything the _merge_ model had not already invented."

So the merge model is constrained to selection, not composition:

> For every passage, you must choose the wording from one of the three
> transcripts, character for character. You may choose different sources for
> different passages. You may drop a passage that is pure transcription noise.
> You may not write a single word that does not appear in at least one of the
> three transcripts, and you may not blend two sources' wordings within a phrase.
> Do not correct grammar, do not smooth phrasing, do not fix a word you believe
> all three got wrong. Speaker labels and line breaks are yours to add; the words
> inside a turn are not.

That constraint is a prompt instruction, so it is enforced mechanically as well.
`checkVerbatimCoverage(turns, sources)` in `masterTranscript.js`:

1. Normalize whitespace and case on every turn's text and on all three source
   transcripts.
2. Split the concatenated master into overlapping 8-word shingles.
3. A shingle passes if it appears in at least one normalized source.
4. Coverage = passing shingles / total shingles.

| Coverage    | Behavior                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| >= 0.98     | Accept. Master is used for extraction.                                                                                                                                                                                                                                     |
| 0.90 – 0.98 | Accept, log `master_transcript.low_coverage` with the failing shingles, write them to the manifest.                                                                                                                                                                        |
| < 0.90      | Reject the master. Extract from `selectFallbackTranscript` instead (ElevenLabs if it produced text, else Qwen, else Dograh), log `master_transcript.verbatim_violation` with which source was substituted, and keep the rejected master in the call folder for inspection. |

Rejecting rather than retrying is deliberate: a model that ignored the constraint
once will likely ignore it again, and every fallback target is a raw ASR
transcript, so the span guarantee holds unconditionally on the rejection path.
That is the whole point of falling back to a raw rather than to a repaired
master. Falling back to ElevenLabs or Qwen keeps the wording accuracy and gives
up only the turn structure, which is the cheaper of the two to lose: extraction
worked without turn structure before this spec existed. Dograh-only remains the
floor, and it is exactly today's behavior, which is known-acceptable.

A raw fallback transcript is flat text with no turns, so the span haystack is
simply that transcript and the turn-bounded-span rule below does not apply. The
extraction prompt's framing is selected to match whichever input it actually
received.

**Span validation after the change.** `validateFields` is called with a _span
haystack_ rather than the rendered master: the turn texts joined by newlines,
with speaker labels excluded. The extraction prompt gains one sentence requiring
a `source_span` to lie within a single turn. A span that straddles a turn
boundary fails validation and the field becomes `[NEEDS INPUT]`, the safe
direction. `validateFields`' own signature and logic do not change; only what the
caller passes as `transcript` changes.

### Rollout mode

New `MASTER_TRANSCRIPT_MODE` script property, one of:

- `off`: stage A skips transcription entirely and sets `transcribed` immediately.
  Behavior identical to today. This is the kill switch.
- `shadow`: stage A runs the full ASR + merge + coverage gate and writes every
  artifact, but stage B still extracts from the Dograh transcript. Lets the real
  output be inspected against real calls with zero risk to the draft.
- `live`: stage B extracts from the master transcript.

Default on first deploy is `shadow`. This is a rollout mechanism, not a
feature flag on the scope decision. The pass is Dograh-only in every mode.

### Data model: Jobs sheet

New columns. `getSheetRows` reads the whole sheet so extra columns are free to
read, but `writeRowFields` throws on a missing header, so a new
`ensureJobsColumns(requiredHeaders)`, the direct analogue of the existing
`ensureClaimsColumns`, runs once per runner tick and appends any missing header.

| Column                     | Contents                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call_folder_id`           | Drive folder ID for this call's artifacts                                                                                                                  |
| `transcript_elevenlabs_id` | Drive file ID of the raw ElevenLabs transcript                                                                                                             |
| `transcript_qwen_id`       | Drive file ID of the raw Qwen transcript                                                                                                                   |
| `transcript_master`        | Rendered master transcript, truncated at 45,000 chars as everything else in this sheet is                                                                  |
| `transcript_master_id`     | Drive file ID of the untruncated master                                                                                                                    |
| `master_coverage`          | Verbatim coverage ratio, 0 to 1                                                                                                                            |
| `transcription_sources`    | Comma-joined list of sources that succeeded, e.g. `elevenlabs,qwen,dograh`                                                                                 |
| `extraction_input`         | What the extractor consumed: `master`, or the source name when a fallback fired. Makes a degraded run visible from the sheet without opening the manifest. |

The existing `transcript` and `transcript_source` columns are untouched and keep
holding Dograh's real-time transcript. Nothing that reads them today changes
meaning.

### Data model: Drive

```
CALL_ARTIFACTS_FOLDER_ID/
└── 2026-08-26 Henderson dograh-14829/
    ├── audio.wav
    ├── transcript-dograh.txt
    ├── transcript-elevenlabs.txt
    ├── transcript-elevenlabs-words.json      (diarized word timings)
    ├── transcript-qwen.txt
    ├── transcript-master.txt
    └── manifest.json
```

`manifest.json` records: capture ID, claim ID and match method, model IDs and
providers actually used, per-source latency and byte counts, reported cost,
coverage ratio, `contested_passages`, which mode the run executed under, and
`extraction_input`, the source the extractor actually consumed (`master`, or the
named single source when a fallback fired). It is the per-call audit record and
the thing to read first when a draft comes out wrong.

### Auth and secrets

- `ELEVENLABS_API_KEY`: new Apps Script property. Sent as the `xi-api-key`
  header. Never logged; `redactParams`-style redaction applies to any log line
  that could carry it.
- `OPENROUTER_API_KEY`: existing, reused for both Qwen and the merge call.
- No webhook, endpoint, or auth-surface changes. Nothing new is exposed publicly;
  every new call is outbound.

### Files touched

New:

- `apps/adjuster/src/transcription.js`: model table, `SOURCE_PRECEDENCE`,
  `selectFallbackTranscript`, keyterm builder, folder management, parallel
  fan-out, per-source parsing, artifact writing.
- `apps/adjuster/src/llm/masterTranscript.js`: merge prompt, merge call,
  coverage gate, turn rendering.

Modified:

- `apps/adjuster/src/runner.js`: two-stage dispatch, matching moved to stage A.
- `apps/adjuster/src/jobs.js`: `ensureJobsColumns`, `getOldestJobByStatus`,
  `transcribed` added to the reclaim/lease status sets.
- `apps/adjuster/src/webhook.js`: `copyRecordingToDrive` targets the call folder.
- `apps/adjuster/src/llm/openrouter.js`: generalize `callOpenRouter`.
- `apps/adjuster/src/prompt.js`: one sentence on turn-bounded spans, applied
  only when the input is a merged master; source framing selected from what the
  extractor actually received (reconciled master, or a named single source on a
  fallback path).
- `apps/adjuster/src/docgen.js`: call-folder link in the doc header block.

Unchanged: `validate.js`, `matcher.js`, `llmMatcher.js`, `templateData.js`,
`calendarSync.js`, `guidedFlow.js`, `config.js`, all enums and templates.

### ADR

One ADR is warranted, covering two coupled decisions: calling ElevenLabs directly
against the OpenRouter-default rule, and constraining a model to verbatim
selection so a downstream span-validation guarantee survives. File as
`docs/adr/007-dual-transcription-and-verbatim-merge.md`.

## Implementation Phases

Each phase is independently deployable and independently valuable.

### Phase 1: Per-call artifact foldering

- `getOrCreateCallFolder` in `transcription.js`; `call_folder_id` column via
  `ensureJobsColumns`.
- `handleDograhNotetaker` writes audio and the Dograh transcript into the call
  folder; `manifest.json` written with what is known at that point.
- `docgen.js` adds a call-folder link to the doc header.
- No ASR, no merge, no extraction change. Pipeline behavior is otherwise
  identical.
- Tests: folder naming including the unmatched case, idempotency on retry, audio
  and transcript land in the right folder, missing `CALL_ARTIFACTS_FOLDER_ID`
  degrades to the existing flat folder rather than throwing.

### Phase 2: Dual ASR in shadow mode

- `TRANSCRIPTION_MODELS`, `buildKeyterms`, `transcribeInParallel`, per-source
  response parsing, raw artifact writing.
- Runner split into stages A and B; matching moves to stage A;
  `MASTER_TRANSCRIPT_MODE` defaults to `shadow` with the merge step stubbed to
  "no master".
- Extraction still reads the Dograh transcript. Nothing user-visible changes.
- Tests: `fetchAll` request construction for both vendors, keyterm capping at
  1000 terms and 50 chars, ElevenLabs `words` to turns, each single-source
  failure mode, `selectFallbackTranscript` returning each precedence tier in turn
  including the both-ASR-sources-dead case, `fetchAll` throwing and
  the sequential fallback taking over, stage transitions and lease reclaim on
  `transcribing`.

### Phase 3: Master transcript merge, still shadow

- `masterTranscript.js` complete: prompt, call, schema, coverage gate, rendering.
- `callOpenRouter` generalized.
- Master written to Drive and to `transcript_master`; coverage and contested
  passages logged and in the manifest. Extraction still on Dograh.
- Run against real calls in this state and read the manifests. This is where the
  merge prompt actually gets tuned.
- Tests: prompt assembly with three, two, and one source; schema shape; coverage
  computation at each threshold band including the exact boundary values;
  rejection path preserving the rejected master; turn rendering; a merge response
  containing invented text is rejected by the gate.

### Phase 4: Flip to live

- `prompt.js` turn-bounded-span sentence; `validateFields` called with the span
  haystack.
- `MASTER_TRANSCRIPT_MODE` set to `live`.
- Manual `retranscribeJob(captureId)` entry point: clears the transcription
  columns, resets `status` to `pending`, and lets the runner redo stage A. Used
  for re-running a call after a prompt or keyterm change. Does not delete the
  previous call folder contents; it versions the filenames.
- Tests: extraction receives the master in `live` and the Dograh transcript in
  `shadow`; spans validating against the haystack; a span straddling two turns
  failing; `retranscribeJob` round-trip.

## Edge Cases & Risk

| Risk                                                                       | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge model ignores the verbatim constraint and rewrites phrasing          | M          | H      | Mechanical coverage gate rejects below the 0.90 threshold and falls back to the highest-precedence raw transcript, normally ElevenLabs. The constraint is never trusted on the prompt alone.                                                                                                                                                       |
| Base64 audio exceeds the 50MB `UrlFetchApp` payload cap on a long call     | L          | M      | 16kHz 16-bit mono wav is ~1.9MB/min, so base64 crosses 50MB around 17 minutes. Guard: if base64 length exceeds 35MB, skip Qwen, log `transcription.audio_too_large`, and merge on the remaining two sources. ElevenLabs is unaffected: it takes the raw blob as multipart, not base64.                                                             |
| Stage A still exceeds 6 minutes on a long call                             | M          | M      | Stage A is one job per tick and contains no doc generation. If it does time out, the lease expires and `reclaimStuckJobs` returns the job to `pending` for retry, capped at 3 attempts. `transcribing` must be added to the leased-status list or timed-out jobs will sit forever.                                                                 |
| One vendor is down or rate-limited                                         | M          | L      | Per-source failure is non-fatal; `selectFallbackTranscript` walks the precedence order and the Stage A table defines behavior at 3, 2, and 1 sources. Dograh-only is today's behavior, so the floor is never worse than current.                                                                                                                   |
| ElevenLabs is chronically preferred and its systematic errors go unnoticed | M          | M      | A fixed precedence means one vendor's blind spots become the master's blind spots. `contested_passages` records every override of ElevenLabs, and the manifest records per-source availability, so the shadow-run data shows how often Qwen was actually right. Precedence is a constant in one place and is cheap to reorder if the data says so. |
| `fetchAll` throws on a transport error and kills both requests             | L          | M      | Wrapped, with a sequential two-call fallback.                                                                                                                                                                                                                                                                                                      |
| Master transcript exceeds the 45,000-char sheet cap                        | L          | L      | Sheet column truncates as every other transcript column does; the untruncated master lives in Drive and `transcript_master_id` points at it. Extraction reads the Drive copy, not the truncated cell.                                                                                                                                              |
| New Jobs columns absent, `writeRowFields` throws mid-pipeline              | M          | H      | `ensureJobsColumns` runs at the top of every runner tick, same pattern as `ensureClaimsColumns`.                                                                                                                                                                                                                                                   |
| Matching moves to stage A and regresses                                    | L          | H      | `matchClaim` and `matchClaimWithLlm` are called with identical arguments from the new location. Existing matcher tests cover the logic; new tests cover the call site.                                                                                                                                                                             |
| ElevenLabs diarization mislabels who is the adjuster                       | M          | M      | Dograh's turn structure is the skeleton, not ElevenLabs'. Diarization is a hint for splitting the batch text, not the source of speaker identity.                                                                                                                                                                                                  |
| Keyterm list leaks claim PII to a second vendor                            | M          | M      | Insured names and addresses already go to OpenRouter in the extraction prompt today, so ElevenLabs is a new processor of data already leaving the system. Flag for Brandon's awareness; note in the ADR. Not a blocker, but it is a real second vendor touching claim data.                                                                        |
| `contested_passages` grows unbounded on a bad call                         | L          | L      | Schema caps the array; anything beyond the first 25 entries is dropped with a log line.                                                                                                                                                                                                                                                            |
| Cost runs away on retries                                                  | L          | L      | One retry per ASR source, existing retry budget on the merge call. Worst case per call is roughly double the estimate, ~$0.20.                                                                                                                                                                                                                     |

**Backwards compatibility.** Phases 1 through 3 are behavior-preserving: the
draft Brandon receives is byte-identical to what it is today. Phase 4 is the only
behavior change, and it is a one-property flip with an immediate revert path
(`MASTER_TRANSCRIPT_MODE=shadow`). The `transcript` and `transcript_source`
columns keep their current meaning throughout, so nothing reading the Jobs sheet
by hand breaks. Jobs created before this change have no `call_folder_id` and are
never revisited; no migration or backfill runs.

## Acceptance Criteria

- [ ] `ELEVENLABS_API_KEY`, `CALL_ARTIFACTS_FOLDER_ID`, `MASTER_TRANSCRIPT_MODEL`,
      and `MASTER_TRANSCRIPT_MODE` documented in `apps/adjuster/template/README.md`
      as required script properties; no key appears in any committed file.
- [ ] A Dograh call in `shadow` mode produces a call folder containing audio,
      three raw transcripts, a master transcript, and a `manifest.json`, and the
      draft Doc is unchanged from what the same call produces today.
- [ ] `UrlFetchApp.fetchAll` is used for the two ASR calls, verified by a test
      asserting a single `fetchAll` invocation with two request objects.
- [ ] Killing either ASR source in a test leaves the job reaching `done` with a
      draft; killing both leaves it reaching `done` from the Dograh transcript.
- [ ] `selectFallbackTranscript` returns ElevenLabs when it has text, Qwen when
      ElevenLabs is empty, and Dograh only when both ASR sources are empty.
- [ ] `checkVerbatimCoverage` returns 1.0 for a master assembled purely from
      source substrings, and rejects a master containing an invented sentence.
- [ ] A merge response below 0.90 coverage results in extraction running on the
      ElevenLabs transcript (or the next available source in precedence order), a
      `master_transcript.verbatim_violation` log line naming the substituted
      source, and the rejected master still present in the call folder.
- [ ] In `live` mode, `extractFields` receives the master transcript and
      `validateFields` receives the label-free span haystack; in `shadow` mode
      both receive the Dograh transcript.
- [ ] `MASTER_TRANSCRIPT_MODE=off` reproduces current behavior exactly.
- [ ] A job left in `transcribing` past its lease is reclaimed to `pending` by
      `reclaimStuckJobs`.
- [ ] `ensureJobsColumns` adds every new column to a Jobs sheet that lacks them,
      and is a no-op on a sheet that has them.
- [ ] `retranscribeJob(captureId)` re-runs stage A on a `done` job without
      destroying the previous run's artifacts.
- [ ] Unit tests for all of the above under `tests/unit/adjuster/`, using the
      existing `loadGs` sandbox harness.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` all pass.
- [ ] ADR filed at `docs/adr/007-dual-transcription-and-verbatim-merge.md`.

## Open Questions

- **Merge model choice.** `MASTER_TRANSCRIPT_MODEL` defaults to whatever
  `OPENROUTER_MODEL` is. The merge task is long-context reconciliation across
  three ~12k-character transcripts, which is a different job from structured
  extraction. Worth A/B-ing during Phase 3 rather than deciding now.
- **Coverage thresholds.** 0.98 and 0.90 are starting values chosen to be
  strict. Phase 3 shadow runs produce the real distribution; tune before Phase 4.
- **Shingle width.** 8 words is a guess at the point where a shingle is long
  enough to be meaningful and short enough not to fail on legitimate
  source-switching at a phrase boundary. Same: tune from shadow-run data.

## Sources

- [ElevenLabs Speech-to-Text API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [ElevenLabs batch keyterm prompting](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting.md)
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
