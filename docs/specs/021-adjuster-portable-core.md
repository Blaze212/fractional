# Adjuster Portable Core

**Status:** Ready for review
**Owner:** Barton
**Last updated:** 2026-09-02
**Linear:** [Brandon Adjuster](https://linear.app/skoodar/project/brandon-adjuster-c5f117dd2c3d) → milestone _Phase 3: Portable core_ (BH-55, BH-56, BH-57, BH-58, BH-59 and their sub-issues)

## Objective

Carve the adjuster pipeline's thinking out of its plumbing. Transcribing, merging, extracting,
validating, and matching become one runtime-agnostic module under `apps/adjuster/src/core/` that
touches no Apps Script global and loads no per-client configuration of its own. Google Docs
rendering, Sheets storage, Drive artifacts, and Calendar seeding stay where they are and become
adapters that call into the core. Client 2 takes the core unchanged and writes their own adapters.
Behaviour for Brandon does not change in any phase of this spec.

## Non-goals

- No behaviour change. Every phase is a refactor; the same call produces the same Doc.
- No port to Supabase Edge Functions, and no second runtime in production. This spec makes that
  port possible later, it does not perform it.
- No review UI. The _Review UI: build options_ milestone stays description-only and undecided.
- No bundler, no module system, no TypeScript conversion of the Apps Script sources. Apps Script's
  single global namespace means `core/` files push and load exactly as they do today (BH-132).
- No changes to the Jobs / Claims / Raw sheet schema, and no Drive layout changes.
- No client 2 adapters. This spec ends when the interface is stated, tested, and runnable from Node.

## Business Rationale

The adjuster pipeline is currently one client's Apps Script project. Every part of it that is
genuinely valuable (claim matching, dual-ASR merge, field extraction, span validation) is entangled
with `DriveApp`, `SpreadsheetApp`, and `PropertiesService`, so selling the same pipeline to a second
client means either copying the whole Google Workspace shape onto them or rewriting the interesting
half. Drawing the boundary once, while the codebase is still small enough to hold in one head, turns
client 2 from a rebuild into an adapter-writing exercise. It also gives the extraction logic a Node
test harness and a regression corpus, which is what makes prompt and model changes safe to make at
all.

Phase 1 (Telnyx retirement, spec 019) already shipped and shrank the surface this phase has to
carve. The guard test below is deliberately the first thing built so nothing new leaks Apps Script
globals into the files intended for `core/` while the move is in flight.

## Architecture

### The boundary

Today's `apps/adjuster/src/` is flat. After this spec:

```
apps/adjuster/src/
  core/            runtime-agnostic. No Apps Script globals, no config loading, no I/O.
  <everything else>  adapters. Google-specific: Sheets, Drive, Docs, Calendar, webhook routing.
```

**Files that move whole into `core/`** (BH-120), all of which already reference zero Apps Script
globals:

| File                      | What it is                                                |
| ------------------------- | --------------------------------------------------------- |
| `matcher.js`              | deterministic claim matching                              |
| `llmMatcher.js`           | LLM fallback matching                                     |
| `validate.js`             | span validation, calendar/claim fallbacks, coverage rules |
| `prompt.js`               | extraction prompt construction                            |
| `llm/masterTranscript.js` | dual-ASR merge, verbatim coverage check, span haystack    |
| `llm/openrouter.js`       | request/response handling for OpenRouter                  |

**Files that split.** `transcription.js` (1107 lines) is the only real surgery. Its pure half moves;
its Drive half stays.

| Moves to `core/`                                                                                    | Stays as adapter                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `buildKeyterms`, `sanitizeKeyterm`                                                                  | `getOrCreateCallFolder`, `getExistingCallFolder`, `buildCallFolderName`                          |
| `buildElevenLabsRequest`, `buildMultipartBody`, `buildQwenRequest`                                  | `writeCallArtifact`, `nextArtifactName`, `readCallArtifact`                                      |
| `probeWav`, `sliceWav`, `buildWavHeader`, `splitForQwen`, `qwenChunkSeconds` and their byte helpers | `readManifest`, `writeManifest`, `appendManifestRun`                                             |
| `parseElevenLabsResponse`, `parseQwenResponse`, `renderDiarizedTurns`, `combineChunks`              | `writeRawTranscripts`                                                                            |
| `selectFallbackTranscript`, `availableSources`, `describeSourcesForManifest`                        | `runTranscriptionPass`, `retranscribeJob` (orchestration, reads/writes Drive and the Jobs sheet) |
| `resolveSourceResponse`, `isRetryableStatus`, `mergeIfPossible`'s decision logic                    | `encodeAudioBase64` (Utilities), `fetchAllWithFallback`, `safeFetch` (UrlFetchApp)               |

`util.js` (`tryJsonParse`, `stitchAIGatherMessages`) is already global-free but its main consumer is
`webhook.js`. Leave it where it is; it can move later at no cost if a core parser wants it.

**Files that stay adapters** and are edited only to call into core (BH-131): `runner.js`,
`docgen.js`, `jobs.js`, `calendarSync.js`, `webhook.js`, `templateData.js`, `replay.js`, `config.js`,
`log.js`.

### Injected dependencies

Core takes what it needs as arguments. Three injections, in priority order.

**1. HTTP (BH-122).** Core takes a fetch-shaped function. The adapter passes a `UrlFetchApp`
wrapper; the Node harness passes `globalThis.fetch`. The shape is deliberately narrow so a
`UrlFetchApp` wrapper is a few lines:

```js
// httpFetch(request) -> { status: number, body: string, headers: object }
// request: { url, method, headers, payload, contentType }
```

Retry and model-fallback behaviour stays inside core (`callOpenRouter` already owns it) because it
is policy, not I/O. Only the single round trip is injected.

**2. Config.** `llmMatcher.js` calls `getConfig` / `getConfigList`, which read
`PropertiesService`. `tagSchema` (today `enums.json`) and `glossary.json` are loaded from Drive by
the adapter. All of it becomes a plain `config` object passed in and never read inside core
(BH-125).

**3. Logging.** This one is easy to miss and matters. `llm/openrouter.js` and
`llm/masterTranscript.js` call `logEvent`, and `logEvent` calls `appendRaw`, which reaches
`SpreadsheetApp` through `jobs.js`. A file under `core/` can therefore write to a Google Sheet
without containing a single Apps Script identifier. Core takes a logger with the existing
`logEvent(event, fields)` / `logServerOnly(event, fields)` shape; the adapter passes today's
`log.js` functions and the Node harness passes a console writer.

### The core contract (BH-56)

Two entry points rather than one. The Linear issue states a single input shape whose `sources`
already carry text, which leaves ASR outside it, while the milestone description puts transcribing
inside the core. Splitting resolves that: transcription is a core capability, and it is a separate
call because adapters fetch the audio bytes.

```js
// Optional. Given audio, produce the source transcripts. Pure logic + injected fetch.
core.transcribe({
  audio, // { bytes, mimeType, durationSeconds }
  keyterms, // from core.buildKeyterms(claim, glossary, adjusterName)
  config, // { apiKeys, models, precedence, masterTranscriptMode, ... }
  deps, // { fetch, logger }
}) // -> { sources: { [name]: { text, words?, turns? } }, attempts }

// The pipeline proper. No I/O of its own beyond deps.fetch.
core.run({
  sources, // { [name]: { text, words?, turns? } }
  claim, // the matched claim, or null
  claims, // candidate claims for matching
  tagSchema, // per-client, passed in (today's enums.json)
  glossary, // per-client, passed in
  liveFields, // the voice platform's own extraction, or null
  config,
  deps, // { fetch, logger }
}) // -> { match, master, extraction, validated, manifest }
```

`validated` is the field map `docgen.js` renders from. `manifest` is the same per-call manifest
shape written to Drive today, returned rather than written. Nothing in the return value is a Drive
file, a Doc, or a Sheet row; producing those is the adapter's job.

The interface is written up as a short ADR so client 2 builds adapters against a stated contract
(BH-126). This is the one genuine architecture decision in the spec.

### Guard test (BH-121)

Two checks, because the lexical one alone is not sufficient.

**Lexical.** Fail the suite if any file under `core/` references `DriveApp`, `DocumentApp`,
`SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`, `LockService`, `CacheService`, `CalendarApp`,
`ScriptApp`, `MailApp`, `GmailApp`, `HtmlService`, `Utilities`, or `Session`.

**Free-identifier.** Fail the suite if a `core/` file calls any cross-file symbol that is not either
defined under `core/` or on a short declared allowlist. This is what catches the `logEvent` →
`appendRaw` → `SpreadsheetApp` path that the lexical check waves through. `tests/unit/adjuster/`
already has the machinery: `loadGs.ts` runs each file in a bare `vm` context seeded only with
`console`, and `sandbox.test.ts` already asserts that no network global exists. Extend that pattern
rather than inventing a second one.

### Deploy impact

`.clasp.json` has `rootDir: ""` and `skipSubdirectories: false`, and `src/llm/` already pushes
today, so `src/core/` needs no clasp change. CI runs `clasp push -f`, which force-syncs and removes
remote files absent locally, so moved files do not leave stale duplicates defining the same
functions twice in the Apps Script project. Verify this on the first deploy after the move rather
than assuming it.

Apps Script concatenates every file into one global scope. Function declarations hoist across files,
so call order is safe. Top-level `var` initialisers run in file order, and every top-level `var` in
the files being moved is a literal or a `RegExp` (checked), so the move cannot reorder an
initialisation dependency. `filePushOrder` stays empty.

## Implementation Phases

Numbered `3.N` so they do not collide with the roadmap's Phase 0-3.

### Phase 3.1 — Guard first, before any move

- Create `apps/adjuster/src/core/` with a placeholder and both guard checks.
- Both checks pass trivially on an empty directory, which is the point: they are in place before any
  file lands, so nothing new leaks in during the move.
- Tests: new `tests/unit/adjuster/coreBoundary.test.ts`.
- Deployable on its own. No production change.

### Phase 3.2 — Inject HTTP, config, and logging

- Add the `deps` parameter to `llm/openrouter.js`, `llm/masterTranscript.js`, and `llmMatcher.js`,
  in place, before they move.
- Adapter callers pass a `UrlFetchApp` wrapper, today's `log.js` functions, and a config object
  assembled from `PropertiesService` at the call site.
- `sandbox.test.ts`'s assertion that `callOpenRouter` throws `UrlFetchApp is not defined` becomes an
  assertion that it throws when no `deps.fetch` is supplied. Keep the intent: an accidental vendor
  call in a unit test must be an error, never a charge.
- Tests: existing `openrouterSchema.test.ts`, `masterTranscript.test.ts`, `llmMatcher.test.ts`
  updated; new cases for a missing/failing injected fetch.
- Deployable on its own.

### Phase 3.3 — Move the whole files (BH-120)

- `git mv` the six files listed above into `core/`.
- Update the `loadGs()` paths in the 16 affected test files. No logic changes in this phase, so any
  test failure is a real regression.
- Verify the first CI deploy leaves no stale remote copies in the Apps Script project.
- Deployable on its own.

### Phase 3.4 — Split `transcription.js`

- Move the pure half per the table above into `core/transcription.js`; leave the Drive and manifest
  half in `apps/adjuster/src/transcription.js`.
- `runTranscriptionPass` keeps its current signature and becomes an adapter that reads audio from
  Drive, calls `core.transcribe`, and writes artifacts and the manifest.
- Tests: `transcription.test.ts` splits along the same seam. The WAV probe/slice cases move to a core
  test and gain a Node-native fixture.
- Deployable on its own.

### Phase 3.5 — Adapters call into core only (BH-131)

- `runner.js`'s `runTranscriptionStage` and `runExtractionStage` become thin: resolve inputs from
  Sheets and Drive, call `core.run`, write the result back.
- `resolveClaimMatch`, `buildExtractionHints`, and `runFieldExtraction` move their decision logic
  into core; what stays is sheet reads and status writes.
- `docgen.js` renders from `validated` and keeps `resolveTagsForDoc` as the tag overlay. Extraction
  logic must not survive anywhere outside `core/`.
- `webhook.js`, `jobs.js`, and `calendarSync.js` are audited for stray extraction logic.
- Tests: `runner.test.ts` and `docgen.test.ts` updated; a core-level test exercises `core.run`
  end-to-end against stub deps.
- Deployable on its own, and the riskiest phase. Ship it alone.

### Phase 3.6 — Node harness (BH-57, BH-127, BH-128)

- `scripts/adjuster-core-run.mjs`: takes a saved recording and transcript from disk, runs the full
  core with `globalThis.fetch` and a console logger, prints the validated field map.
- Extends what `scripts/stt-transcribe.mjs` and `scripts/adjuster-inject-test-job.mjs` already do.
  Reuse their argument and output conventions.
- Live vendor calls, so it is a developer tool run by hand and never wired into `pnpm test`.
- This is the dev loop for client 2 before any of their infrastructure exists.

### Phase 3.7 — Regression corpus (BH-58, BH-129, BH-130)

- Five to ten anonymized calls with expected validated output, checked in under
  `tests/fixtures/adjuster/`. The directory does not exist yet.
- Each fixture holds: source transcripts, claim and claims list, `tagSchema`, `glossary`,
  `liveFields`, recorded LLM responses, and the expected `validated` map.
- **Default suite:** runs core against the fixtures with recorded LLM responses replayed through a
  stub `deps.fetch`. Deterministic, free, and it preserves the sandbox invariant that `pnpm test`
  cannot dial a vendor.
- **Opt-in live job:** a separate CI job, manual dispatch or scheduled rather than on every push,
  runs the same fixtures against real models and prints the field-by-field diff. This is what makes
  a prompt or model change show its blast radius before it merges.
- See the risk table for why the corpus is split this way rather than run live on every push.

### ADR

File `docs/adr/009-adjuster-portable-core-contract.md` in Phase 3.3, covering the boundary, the
injected-dependency shape, and the `core.transcribe` / `core.run` contract (BH-126).

## Edge Cases & Risk

| Risk                                                                                                                                                                   | Likelihood             | Impact | Mitigation                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Indirect global leak: a `core/` file calls `logEvent`, which reaches `SpreadsheetApp` via `appendRaw`. The lexical guard passes.                                       | H (it is true today)   | H      | The free-identifier guard in Phase 3.1. Logger is injected in Phase 3.2, before any file moves.                                                                                      |
| Indirect config leak: `llmMatcher.js` calls `getConfig` → `PropertiesService`.                                                                                         | H (true today)         | M      | Same guard. Config injected in Phase 3.2 (BH-125).                                                                                                                                   |
| Live LLM calls in the CI regression corpus: cost per push, nondeterministic diffs, and it breaks the `sandbox.test.ts` guarantee that unit tests cannot dial a vendor. | H if run on every push | H      | Recorded responses in the default suite; live runs in a separate opt-in job (Phase 3.7).                                                                                             |
| PII in the anonymized corpus. Real calls carry names, addresses, carriers, and claim numbers.                                                                          | M                      | H      | Anonymize at fixture-creation time and review each fixture by hand before it is committed. No recordings, no raw Drive artifacts, transcripts only.                                  |
| Stale duplicate files in the Apps Script project after the move, defining the same functions twice.                                                                    | L                      | H      | `clasp push -f` force-syncs and removes remote files absent locally. Verify the project file list on the first deploy after Phase 3.3.                                               |
| Top-level `var` initialisation order changes when files move.                                                                                                          | L                      | H      | Every top-level `var` in the moved files is a literal or `RegExp` (verified). Re-check if a moved file gains a computed top-level initialiser.                                       |
| Phase 3.5 changes behaviour while claiming not to. It is the phase where logic actually relocates.                                                                     | M                      | H      | Ship 3.5 alone. `runner.test.ts` and `docgen.test.ts` are the contract; the Phase 3.7 corpus is the backstop, so land 3.7's fixtures before or alongside 3.5 if the schedule allows. |
| Retell / Dograh ingest regressions from `webhook.js` edits in Phase 3.5.                                                                                               | M                      | H      | The Phase 0 contract tests (BH-87) pin the `dograh_notetaker`, `dograh_pre_call`, and `manual_recording_inject` payloads and the exact Jobs row they produce. Do not weaken them.    |
| Scope creep into the Supabase port or the review UI.                                                                                                                   | M                      | M      | Explicit non-goal. The review-UI decision trigger is unchanged and stays in its own milestone.                                                                                       |

## Open Questions

1. **`core.transcribe` split.** BH-123's input shape puts already-transcribed `sources` into core,
   while the milestone description puts transcribing inside it. This spec resolves that with two
   entry points. Confirm before Phase 3.4, since it fixes the seam in `transcription.js`.
2. **Corpus fixture source.** Which five to ten calls, and who anonymizes them. Blocking for Phase
   3.7, nothing earlier.
3. **`util.js`.** Left as an adapter file. Move it if a core parser ends up wanting `tryJsonParse`.

## Acceptance Criteria

- [ ] `apps/adjuster/src/core/` exists and contains `matcher.js`, `llmMatcher.js`, `validate.js`, `prompt.js`, `masterTranscript.js`, `openrouter.js`, and the pure half of `transcription.js`
- [ ] Guard test fails the suite if any `core/` file references an Apps Script global
- [ ] Guard test fails the suite if any `core/` file calls a cross-file symbol outside `core/` and the declared allowlist
- [ ] `core.run` and `core.transcribe` take `deps.fetch` and `deps.logger`; neither reads `PropertiesService` nor loads `enums.json` or `glossary.json`
- [ ] `tagSchema` and `glossary` are arguments at every core call site
- [ ] No extraction, validation, matching, or merge logic remains in `runner.js`, `docgen.js`, `jobs.js`, `calendarSync.js`, or `webhook.js`
- [ ] `scripts/adjuster-core-run.mjs` runs the full core on a recording and transcript from disk and prints the validated field map
- [ ] Five to ten anonymized fixtures under `tests/fixtures/adjuster/`, each with expected validated output
- [ ] Default `pnpm test` runs the corpus against recorded responses and makes zero network calls
- [ ] A separate opt-in CI job runs the corpus live and prints a field-by-field diff
- [ ] Phase 0 contract tests (BH-87) still pass unchanged
- [ ] A scripted A/B call produces the same draft as before the refactor, field for field
- [ ] ADR filed at `docs/adr/009-adjuster-portable-core-contract.md`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` pass
- [ ] No hardcoded secrets; all keys stay in Script Properties on the adapter side
- [ ] First deploy after the move verified: no stale duplicate files in the Apps Script project
