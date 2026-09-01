# Retell in the Transcription Layer

**Status:** Implemented — completed 2026-08-31
**Owner:** Adjuster (Brandon)
**Last updated:** 2026-08-31

Corresponds to Linear BH-43 (parent), BH-81 through BH-86.

## Objective

Brandon's insurance-adjuster voice-agent product (`apps/adjuster/`) runs the
dual-transcription / master-transcript pipeline from spec 012
(`apps/adjuster/src/transcription.js`, `apps/adjuster/src/llm/masterTranscript.js`,
`apps/adjuster/src/prompt.js`) only for Dograh calls: `runTranscriptionPass()`
gates on the literal check `job.source !== 'dograh'`, the third (streaming)
slot in `SOURCE_PRECEDENCE` is hardcoded to the key `'dograh'`, and the merge
prompt's source descriptions and disagreement-resolution order name Dograh by
name. Phase 0 of the "add Retell as a second voice platform" effort needs
this layer to treat a Retell job's own live transcript exactly the way it
already treats Dograh's — same precedence rank, same merge behavior, same
verbatim-fallback guarantee — without knowing or caring which vendor produced
it. This spec makes that gate and that precedence slot source-aware, driven
by an explicit allowlist of voice platforms instead of one hardcoded string,
and generalizes the label/prompt text describing that third source so it no
longer misdescribes a Retell call as "Dograh."

Spec 014 (Retell post-call ingest, not yet written) is what will actually set
`job.source = 'retell'` on a job via a new webhook handler. This spec does
not add that handler — it makes the transcription layer correct for the
moment a job with `source: 'retell'` starts arriving, so the two pieces of
work can land and be reviewed independently and in either order.

## Non-goals

- No new Retell webhook route, credential, or ingest handler
  (`apps/adjuster/src/webhook.js`) — that is spec 014's job. This spec treats
  `job.source === 'retell'` as a given input, not something it produces.
- No change to `fetchDograhTranscript()` (`apps/adjuster/src/webhook.js:562`).
  It is Dograh-webhook-specific (parses `body.transcript_url` from a Dograh
  Notetaker payload) and lives outside the transcription layer entirely — see
  "`fetchDograhTranscript()` — grounded finding" below for why it is left
  alone rather than deleted or generalized.
- No change to Dograh Notetaker's live per-field extraction hints
  (`job.dograh_fields`, `runner.js`'s `isDograh` branch at
  `runExtractionStage()`). That is a different feature (per-field capture via
  Dograh's own dashboard export) from the streaming-transcript precedence
  this spec generalizes; a Retell equivalent, if any, is a separate spec.
- No change to `MASTER_TRANSCRIPT_MODE` itself or its default. See
  "`MASTER_TRANSCRIPT_MODE` — grounded finding" below: the code's default
  fallback is still `'shadow'`; the Linear decision that production now runs
  `'live'` is a deployed Apps Script property value, not a code change, and
  is out of scope here.
- No new Jobs-sheet column. `job.source` already carries the platform at the
  row level (set by whichever webhook handler wrote the job); this spec only
  adds a `voice_platform` field to the per-call Drive `manifest.json`, which
  today has no platform field on its stage-A run entries at all.
- No live Retell call, no Retell-specific ASR tuning (keyterms, model choice)
  — ElevenLabs/Qwen remain the two batch models regardless of which platform
  supplied the third, live source.

## Business Rationale

Without this change, the moment spec 014 lands and a real job shows up with
`job.source === 'retell'`, `runTranscriptionPass()`'s `job.source !== 'dograh'`
gate silently skips the entire master-transcript pipeline for it — every
Retell call would run one full ASR/precedence generation behind Dograh calls,
on a pipeline that was supposed to be platform-agnostic by design (Phase 0's
stated goal). Making the gate and precedence source-aware now means spec 014
can ship a webhook handler alone, with the transcription layer already
correct, instead of the two specs having to land together or in a fixed
order.

## Architecture

### Current state (grounded in the real code)

**The gate** — `runTranscriptionPass()`, `apps/adjuster/src/transcription.js:814-831`:

```js
function runTranscriptionPass(job, claim) {
  var mode = getMasterTranscriptMode()
  var captureId = job.capture_id

  if (mode === 'off') {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'mode_off' })
    return { extraction_input: 'dograh' }
  }

  if (job.source !== 'dograh') {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'not_dograh' })
    return {}
  }

  if (!job.audio_drive_id) {
    logEvent('transcription.skipped', { capture_id: captureId, reason: 'no_audio' })
    return { extraction_input: 'dograh' }
  }
  ...
```

`job.source` is set to the literal string `'dograh'` in exactly two places,
both Dograh-specific webhook handlers (`apps/adjuster/src/webhook.js:440`,
`:486`). Telnyx jobs never set `job.source` at all, so today's gate
implicitly also excludes them — that is intentional pre-existing behavior
(Telnyx has its own transcript-only path; see `prompt.js`'s comment "a Telnyx
job has no entry here and gets the unchanged prompt") and stays unchanged.

**The precedence slot** — `SOURCE_PRECEDENCE`, `transcription.js:35`:

```js
var SOURCE_PRECEDENCE = ['elevenlabs', 'qwen', 'dograh']
```

This same literal array is read directly (not parameterized) by
`selectFallbackTranscript()`, `availableSources()`, `describeSourcesForManifest()`,
the `transcription.degraded`/`lost` log line inside `mergeIfPossible()`, and —
across the module boundary, since Apps Script concatenates every `.js` file
into one global scope at deploy time — by `buildMasterTranscriptPrompt()` in
`apps/adjuster/src/llm/masterTranscript.js:67`. `runTranscriptionPass()` also
builds the `sources` object with the third key hardcoded:

```js
var sources = {
  elevenlabs: asr.elevenlabs || { text: '' },
  qwen: asr.qwen || { text: '' },
  dograh: { text: String(job.transcript || '') },
}
```

**The label and merge-prompt text** — `masterTranscript.js:21-26`:

```js
var SOURCE_LABELS = {
  elevenlabs: 'ElevenLabs Scribe v2 — batch, diarized, keyterm-biased, ranked FIRST on wording',
  qwen: 'Qwen3 ASR Flash — batch, keyterm-biased, ranked SECOND on wording',
  dograh:
    'Dograh — real-time streaming transcript captured during the call. FIRST on turn structure, LAST on wording.',
}
```

`buildMasterTranscriptPrompt()`'s system-prompt prose also names Dograh
directly in the disagreement-resolution order ("ElevenLabs first, Qwen
second, Dograh last") and in the per-rule bullets ("Dograh disagreeing with
both batch models is the expected case...", "Use Dograh's wording only
where...").

**The extraction-time framing** — `TRANSCRIPT_SOURCE_FRAMING`,
`apps/adjuster/src/prompt.js:6-14`, has a `dograh` key whose _text_ is
already platform-generic ("the call's real-time streaming transcription,
produced live during the call as the adjuster spoke.") — it just has no
`retell` key, so a Retell fallback transcript would render with `''`
framing (the same silent no-framing behavior a Telnyx transcript gets today,
which is wrong for a live-recorded call).

**The bug this spec actually fixes, not just the gate** —
`resolveExtractionTranscript()`, `transcription.js:1000-1028`:

```js
function resolveExtractionTranscript(job) {
  var dograhText = String(job.transcript || '')
  var dograh = {
    source: job.source === 'dograh' ? 'dograh' : '',
    ...
  }
  ...
  return dograh
}
```

This is the actual reason "make `SOURCE_PRECEDENCE` source-aware" matters
beyond the gate: even if the gate above were widened to admit `'retell'`, a
Retell job's fallback path would still resolve `source: ''` here (because
the comparison is hardcoded to the literal `'dograh'`), which zeroes out
`TRANSCRIPT_SOURCE_FRAMING` and silently drops the "this is a live streaming
transcript" framing the extractor is supposed to get. Widening the gate
alone is not sufficient; this function has to stop hardcoding the platform
name too.

### `fetchDograhTranscript()` — grounded finding

The task description assumed this function lives in `transcription.js`. It
does not — it is defined in `apps/adjuster/src/webhook.js:562-577`, called
only from `handleDograhNotetaker()` (`webhook.js:430`), and its own comment
block is explicit that it is **unconfirmed against a live call**:

> UNCONFIRMED AGAINST A LIVE CALL: Dograh's docs describe `transcript_url`
> only as "a public download URL for the call transcript" — the content type
> isn't documented.

Per the task's explicit instruction, `fetchDograhTranscript()` is **left in
place, untouched**, rather than deleted or generalized: its content-type
handling has not been confirmed against a real payload, it lives outside the
transcription layer this spec touches, and it is exclusively used by a
Dograh-specific handler that this spec does not modify. A future Retell
ingest spec (014) will need its own transcript-acquisition path — Retell's
webhook contract is a different shape entirely (Retell delivers
`transcript`/`transcript_object` inline in its `call_analyzed` webhook per
Retell's own docs, not a fetch-by-URL step) — so there is no shared code to
extract here even if `fetchDograhTranscript()`'s shape were confirmed.

### `MASTER_TRANSCRIPT_MODE` — grounded finding

`getMasterTranscriptMode()` (`transcription.js:77-79`) still reads:

```js
function getMasterTranscriptMode() {
  return getOptionalConfig('MASTER_TRANSCRIPT_MODE', 'shadow')
}
```

The code's fallback default is `'shadow'`, unchanged since spec 012. The
Linear decision that production now runs in `'live'` mode is carried by the
deployed Apps Script property `MASTER_TRANSCRIPT_MODE`, not by this
in-code default — `getOptionalConfig()` only falls back to `'shadow'` when
the property is entirely unset, which is not the current production state.
Per this spec's non-goals, the in-code default is left as-is; flipping it
would be a separate, deliberate decision (and would only matter for an
environment where the property was never set at all, e.g. a fresh
`clasp create` deploy).

### Design

**1. An explicit allowlist replaces the literal comparison.**

```js
// Voice platforms this pass can source a streaming transcript from. A job
// whose source isn't in this list (Telnyx, or anything future) skips stage A
// entirely and rides the floor: whatever transcript already lives on the job.
var VOICE_PLATFORM_SOURCES = ['dograh', 'retell']
```

`runTranscriptionPass()`'s gate becomes:

```js
var voiceSource = VOICE_PLATFORM_SOURCES.indexOf(job.source) !== -1 ? job.source : ''

if (mode === 'off') {
  logEvent('transcription.skipped', { capture_id: captureId, reason: 'mode_off' })
  return { extraction_input: voiceSource || 'dograh' }
}

if (!voiceSource) {
  logEvent('transcription.skipped', { capture_id: captureId, reason: 'unsupported_source' })
  return {}
}

if (!job.audio_drive_id) {
  logEvent('transcription.skipped', { capture_id: captureId, reason: 'no_audio' })
  return { extraction_input: voiceSource }
}
```

The skip reason changes from `'not_dograh'` to `'unsupported_source'`
(accurate now that more than one platform is supported); the mode-off path
keeps its pre-existing, behaviorally-inert quirk of defaulting to `'dograh'`
when `job.source` isn't a recognized voice platform (unchanged from today,
out of scope to fix here — see Non-goals).

**2. The `sources` object and precedence are built per-job, not off a fixed
module constant.**

```js
var precedence = ['elevenlabs', 'qwen', voiceSource]
var sources = {
  elevenlabs: asr.elevenlabs || { text: '' },
  qwen: asr.qwen || { text: '' },
}
sources[voiceSource] = { text: String(job.transcript || '') }
```

`selectFallbackTranscript()`, `availableSources()`, and
`describeSourcesForManifest()` each gain a second `precedence` parameter that
defaults to the module-level `SOURCE_PRECEDENCE` constant when omitted (so
every existing direct call/test that doesn't pass one keeps working
unchanged — `SOURCE_PRECEDENCE` itself stays `['elevenlabs', 'qwen', 'dograh']`
as that default/shape reference). `mergeIfPossible()` gains the same
parameter and forwards it to `buildGatedMasterTranscript()` as
`input.precedence`. `runTranscriptionPass()` passes the per-job `precedence`
array to all four call sites instead of relying on the global.

**3. `masterTranscript.js` reads precedence from the input, not the global,
and drops the fixed `dograh` label.**

```js
var SOURCE_LABELS = {
  elevenlabs: 'ElevenLabs Scribe v2 — batch, diarized, keyterm-biased, ranked FIRST on wording',
  qwen: 'Qwen3 ASR Flash — batch, keyterm-biased, ranked SECOND on wording',
}

// The job's own live transcript, from whichever voice platform handled the
// call (see VOICE_PLATFORM_SOURCES in transcription.js). Not a fixed
// SOURCE_LABELS entry because the platform varies per job — every precedence
// name that isn't 'elevenlabs' or 'qwen' falls back to this generic label.
var STREAMING_SOURCE_LABEL =
  "The call platform's own real-time transcript — captured live during the call. FIRST on turn structure, LAST on wording."
```

`buildMasterTranscriptPrompt()` iterates `input.precedence || SOURCE_PRECEDENCE`
instead of the bare global, and looks up
`SOURCE_LABELS[name] || STREAMING_SOURCE_LABEL`. The system-prompt prose is
reworded to describe the third source generically ("the call platform's own
real-time transcript ... produced live during the call") instead of naming
Dograh, and "ElevenLabs first, Qwen second, Dograh last" becomes "ElevenLabs
first, Qwen second, the call platform's live transcript last" (and likewise
in the per-bullet disagreement rules). This is wording-only — the actual
precedence order and verbatim-constraint logic are unchanged.

**4. `resolveExtractionTranscript()` stops hardcoding the platform name.**

```js
function resolveExtractionTranscript(job) {
  var voiceText = String(job.transcript || '')
  var voiceFallback = {
    source: VOICE_PLATFORM_SOURCES.indexOf(job.source) !== -1 ? job.source : '',
    transcript: voiceText,
    haystack: voiceText,
  }
  ...
  return voiceFallback
}
```

For a Dograh job this is behaviorally identical to today (`job.source ===
'dograh'` was already the only value that satisfied the old check). For a
Retell job, `voiceFallback.source` now correctly resolves to `'retell'`
instead of `''`.

**5. `prompt.js`'s `TRANSCRIPT_SOURCE_FRAMING` gets a `retell` key.**

`prompt.test.ts` loads `prompt.js` standalone (not alongside
`transcription.js`), so `TRANSCRIPT_SOURCE_FRAMING` cannot reference
`VOICE_PLATFORM_SOURCES` as a shared constant without breaking that
isolation — it stays a plain literal object, with `retell` added using the
same (already platform-generic) wording the `dograh` key already has:

```js
var TRANSCRIPT_SOURCE_FRAMING = {
  master: '...', // unchanged
  elevenlabs: '...', // unchanged
  qwen: '...', // unchanged
  dograh:
    "The transcript below is the call's real-time streaming transcription, produced live during the call as the adjuster spoke.",
  retell:
    "The transcript below is the call's real-time streaming transcription, produced live during the call as the adjuster spoke.",
}
```

**6. The per-call manifest records `voice_platform`.**

The per-call manifest (`manifest.json`, written via `writeManifest()` /
`appendManifestRun()`, `transcription.js:240-261`) gets a `voice_platform`
field on each stage-A run entry, inside `runTranscriptionPass()`'s existing
`appendManifestRun()` call:

```js
appendManifestRun(folder, {
  stage: 'transcription',
  mode: mode,
  at: new Date().toISOString(),
  capture_id: captureId,
  claim_id: (claim && claim.claim_id) || '',
  voice_platform: job.source || '',
  match_method: job.match_method || '',
  ...
})
```

This is the manifest write this spec owns (stage A's audit record — "the
first thing to read when a draft comes out wrong," per the file's own
comment). The _initial_ manifest written at webhook time
(`webhook.js`'s `tryWriteCallArtifacts()`, called from
`handleDograhNotetaker()`/`handleManualRecordingInject()`) is Dograh-specific
webhook code, out of scope per this spec's non-goals; a future Retell
ingest handler (spec 014) will need to write its own initial manifest the
same way, with `voice_platform: 'retell'`.

## Implementation Phases

### Phase 1 — `transcription.js`: allowlist gate, source-aware precedence, manifest field

- Add `VOICE_PLATFORM_SOURCES`.
- Rewrite `runTranscriptionPass()`'s gate to use the allowlist; rename the
  skip reason `'not_dograh'` → `'unsupported_source'`.
- Build `sources`/`precedence` per-job instead of a hardcoded `dograh` key.
- Add the `precedence` parameter (default `SOURCE_PRECEDENCE`) to
  `selectFallbackTranscript()`, `availableSources()`,
  `describeSourcesForManifest()`, `mergeIfPossible()`; thread it through.
- Fix `resolveExtractionTranscript()`'s hardcoded `job.source === 'dograh'`
  check to use `VOICE_PLATFORM_SOURCES`.
- Add `voice_platform: job.source || ''` to the `appendManifestRun()` call.
- Update file-top and `SOURCE_PRECEDENCE` comments that currently describe
  the pipeline as Dograh-only.
- Tests: `tests/unit/adjuster/transcription.test.ts` — update the existing
  "leaves a Telnyx job entirely alone" test's expected skip reason; add
  cases for a `retell` job through the gate, precedence, fallback, and
  manifest `voice_platform`.

### Phase 2 — `llm/masterTranscript.js`: generic labels and merge prompt

- Drop the fixed `dograh` entry from `SOURCE_LABELS`; add
  `STREAMING_SOURCE_LABEL` as the fallback for any precedence name that
  isn't `elevenlabs`/`qwen`.
- `buildMasterTranscriptPrompt()` reads `input.precedence || SOURCE_PRECEDENCE`
  and looks up `SOURCE_LABELS[name] || STREAMING_SOURCE_LABEL`.
- Reword the system-prompt prose (disagreement order, per-bullet rules) to
  describe the third source generically instead of naming Dograh.
- `selectFallbackTranscript()` call inside `buildGatedMasterTranscript()`'s
  logging passes `input.precedence` through.
- Tests: `tests/unit/adjuster/masterTranscript.test.ts` — update the
  existing tests that assert literal "Dograh" text to assert the new generic
  wording; add a case exercising `precedence: ['elevenlabs', 'qwen', 'retell']`
  with a `sources.retell` entry to confirm the merge prompt treats it
  identically to a `dograh` entry (label, ordering, verbatim coverage).

### Phase 3 — `prompt.js`: extraction-time framing for Retell

- Add the `retell` key to `TRANSCRIPT_SOURCE_FRAMING`.
- Tests: `tests/unit/adjuster/prompt.test.ts` — add a case mirroring the
  existing "describes the Dograh transcript as the real-time one" test for
  `transcriptSource: 'retell'`.

### Phase 4 — Final verification

- `pnpm typecheck`
- `pnpm vitest run tests/unit/adjuster` (full adjuster suite, not just the
  touched files, since `masterTranscript.test.ts` loads all three source
  files together)
- `pnpm format` then `pnpm lint`
- `pnpm test` (full repo suite) before pushing, per the Verification
  workflow.

## Edge Cases & Risk

| Risk                                                                                                                                     | Likelihood               | Impact | Mitigation                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A job somehow has `job.source` set to a value in `VOICE_PLATFORM_SOURCES` but no real live transcript on `job.transcript` (empty string) | L                        | L      | Unchanged from today's Dograh-only behavior — `availableSources()` already excludes any source whose `text` is blank; the merge just runs on whatever's left (2 sources, or 1 and no merge at all), same as an ASR vendor failing.                                                                                |
| Widening the gate to admit `retell` before spec 014 exists means no real job will ever actually have `job.source === 'retell'` yet       | H (until spec 014 ships) | None   | Purely inert until spec 014 sets that value; covered by this spec's own tests using a synthetic job object, same as `masterTranscript.test.ts` already does for `dograh`.                                                                                                                                         |
| Renaming the skip-reason log value (`'not_dograh'` → `'unsupported_source'`) breaks a log-based dashboard/alert keyed on the old string  | L                        | L      | No dashboard or alert on this event was found in the codebase (`logEvent('transcription.skipped', ...)` is read only by this spec's own tests); flagged here in case one exists outside the repo.                                                                                                                 |
| `TRANSCRIPT_SOURCE_FRAMING.retell` and `.dograh` are now two copies of identical text (duplication, not a shared constant)               | L                        | L      | Deliberate — `prompt.js` is loaded standalone in its own test file and must not depend on `transcription.js`'s `VOICE_PLATFORM_SOURCES` global at module-load time; documented inline in the code. A future third platform repeats the same one-line duplication rather than introducing a cross-file dependency. |
| A precedence array with more than 3 entries (a hypothetical third voice platform slot) is never exercised                                | L                        | L      | Out of scope — `VOICE_PLATFORM_SOURCES` only ever contributes one slot per job (`job.source` is a single value), so `precedence` is always exactly `['elevenlabs', 'qwen', <one source>]`.                                                                                                                        |

## Acceptance Criteria

- [ ] `runTranscriptionPass()` gates on `VOICE_PLATFORM_SOURCES` (`['dograh', 'retell']`), not `job.source !== 'dograh'`.
- [ ] A job with `source: 'retell'` and `audio_drive_id` set runs the full ASR fan-out, merge, and fallback path exactly as a `source: 'dograh'` job does today (same coverage gate, same manifest shape, same `extraction_input` resolution logic).
- [ ] `SOURCE_PRECEDENCE`'s third slot is resolved per-job from `job.source` (via the allowlist) rather than a hardcoded `'dograh'` literal, threaded through `selectFallbackTranscript()`, `availableSources()`, `describeSourcesForManifest()`, and `buildMasterTranscriptPrompt()`.
- [ ] `resolveExtractionTranscript()` resolves `source: 'retell'` (not `''`) for a Retell job's fallback path, so `TRANSCRIPT_SOURCE_FRAMING` framing is applied.
- [ ] `SOURCE_LABELS` and the merge prompt's system text no longer name "Dograh" specifically for the third/streaming source; wording is generic ("the call platform's own real-time transcript") and applies identically regardless of `job.source`.
- [ ] `TRANSCRIPT_SOURCE_FRAMING` has a `retell` key.
- [ ] The per-call manifest's stage-A run entry (`appendManifestRun()` in `transcription.js`) includes a `voice_platform` field set from `job.source`.
- [ ] `fetchDograhTranscript()` is left unchanged in `webhook.js`, with this spec documenting why (unconfirmed payload shape, out of transcription-layer scope, no Retell equivalent to share it with).
- [ ] Unit tests cover precedence and fallback behavior with a `retell` source in the mix (not just `dograh`), across `transcription.test.ts`, `masterTranscript.test.ts`, and `prompt.test.ts`.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm lint` all pass.
- [ ] No hardcoded secrets.
