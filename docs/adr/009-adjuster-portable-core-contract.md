# ADR 009 — The Adjuster Portable Core: Boundary, Injected Dependencies, and Contract

**Status:** Accepted
**Date:** 2026-09-02
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/021-adjuster-portable-core.md

---

## Context

The adjuster pipeline is one client's Google Apps Script project. Everything in
it that is genuinely valuable — claim matching, the dual-ASR merge, field
extraction, span validation — is entangled with `DriveApp`, `SpreadsheetApp`,
and `PropertiesService`. Selling the same pipeline to a second client therefore
means either copying the whole Google Workspace shape onto them or rewriting
the interesting half.

ADR 006 chose Apps Script as the runtime and is not being revisited here. This
decision is narrower: where the line between the thinking and the plumbing
sits, what crosses it, and in which direction.

The line has to be stated rather than merely drawn, because Apps Script
concatenates every file in a project into one global scope. There is no module
system, no bundler, and no import statement — `src/core/matcher.js` and
`src/docgen.js` are equally visible to each other at runtime. A boundary in
that environment is a convention, and a convention nobody can mechanically
check is a convention that decays.

## Decision

### 1. The boundary is `apps/adjuster/src/core/`

Everything under `core/` is runtime-agnostic: it names no Apps Script global,
loads no per-client configuration of its own, and performs no I/O beyond the
injected `deps.fetch`. Everything else in `apps/adjuster/src/` is an adapter:
Sheets storage, Drive artifacts, Docs rendering, Calendar seeding, webhook
routing.

Core holds claim matching (deterministic and LLM), the extraction prompt,
OpenRouter request and response handling, the dual-ASR merge and its verbatim
coverage check, span validation and the coverage rules, and the pure half of
transcription — keyterms, WAV probing and slicing, request building, response
parsing, source precedence.

Adapters hold everything that touches Google: the per-call Drive folder and its
artifacts, the call manifest, the Jobs and Claims sheets, the generated
Document, the calendar sync, and the two-stage runner that drives them.

`util.js` stays an adapter file. It is already global-free, but its consumer is
`webhook.js`; it can move later at no cost if a core parser wants
`tryJsonParse`.

### 2. The boundary is enforced by two tests, not by discipline

`tests/unit/adjuster/coreBoundary.test.ts` fails the suite when either holds:

**Lexical.** A file under `core/` names `DriveApp`, `DocumentApp`,
`SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`, `LockService`,
`CacheService`, `CalendarApp`, `ScriptApp`, `MailApp`, `GmailApp`,
`HtmlService`, `Utilities`, or `Session`.

**Free-identifier.** A file under `core/` references a cross-file symbol that
is neither defined under `core/` nor on a short declared allowlist.

The second check is the one that earns its keep. `logEvent()` calls
`appendRaw()`, which reaches `SpreadsheetApp` through `jobs.js` — so before
this ADR a core file could write to a Google Sheet without containing a single
Apps Script identifier, and the lexical check would wave it through. The
free-identifier check fails on `logEvent` itself.

Both checks run over the parsed AST rather than over the raw text, so a name
inside a comment or a string literal never reads as a reference and a local
variable never reads as a free identifier. The allowlist holds one entry
(`console`); growing it is a reviewable act, because each new entry is a symbol
core may reach for without it being passed in.

### 3. Core takes its host as an argument

Three things cross into core, all as plain values.

**Configuration** is a plain object, assembled by the adapter from
`PropertiesService` at the call site and never read inside core. `tagSchema`
(today `enums.json`) and `glossary` are likewise arguments at every core call
site, not files core loads from Drive.

**`deps`** carries the runtime primitives:

```js
// One round trip. Nothing more.
deps.fetch(request) -> { status, body, headers }
//   request: { url, method, headers, payload, contentType }

// Optional. Concurrent batch, for the two ASR calls.
deps.fetchAll(requests) -> { responses: [response|null], mode }

deps.logger.logEvent(event, fields)
deps.logger.logServerOnly(event, fields)

deps.sleep(ms)                    // blocking
deps.base64Encode(bytes) -> string
deps.stringToBytes(text) -> number[]
```

Retry and model fallback stay inside core: they are policy, not I/O, and a
second client should inherit them rather than reimplement them. Only the single
round trip is injected.

`sleep`, `base64Encode`, and `stringToBytes` are injected for a duller reason
than the others: Apps Script has no `Promise`, no `Buffer`, and no
`TextEncoder`. Core is synchronous by construction, so backoff needs a blocking
primitive from the host, and hand-rolling UTF-8 encoding inside core would risk
changing the exact bytes that reach ElevenLabs.

The Apps Script side of all of this lives in one file,
`apps/adjuster/src/coreDeps.js`. A second client replaces that file and nothing
under `core/`.

### 4. The contract is composable steps, and `core.run` composes them

```js
// Optional. Given audio, produce the source transcripts.
core.transcribe({ audio, keyterms, config, deps })
//   -> { sources: { [name]: { text, words?, turns? } }, attempts }

// The pipeline proper. No I/O of its own beyond deps.fetch.
core.run({ sources, claim, claims, tagSchema, glossary, liveFields, config, deps })
//   -> { match, master, extraction, validated, manifest }
```

`validated` is the field map `docgen.js` renders from. `manifest` is the same
per-call manifest shape written to Drive today, returned rather than written.
Nothing in either return value is a Drive file, a Doc, or a Sheet row;
producing those is the adapter's job.

Two entry points rather than one, because adapters fetch the audio bytes:
transcription is a core capability but it is a separate call.

`core.run` is a composition of individually exported steps — `core.match`,
`core.merge`, `core.buildExtractionHints`, `core.extract`, `core.validate` —
and adapters may call those steps directly. This matters for the existing
runner, which is a two-stage machine: matching and the merge run in one Apps
Script execution and extraction and rendering in the next, because two ASR
round trips plus a long-context merge plus extraction plus docgen do not
reliably fit inside the six-minute execution cap. Requiring every adapter to
enter through `core.run` would have forced that machine back into one
execution, which is a behaviour change wearing a refactor's clothes.

So: `core.run` is the whole pipeline in one call, for the Node harness, the
regression corpus, and any client whose runtime has no such cap. The Apps
Script adapter enters at the step boundaries instead. Both paths run the same
code.

## Consequences

**Client 2 writes adapters, not a pipeline.** They implement `deps`, supply a
config object, a `tagSchema`, and a `glossary`, and call `core.transcribe` and
`core.run`. Nothing under `core/` changes.

**The extraction logic gets a Node test harness.**
`scripts/adjuster-core-run.mjs` runs the full core against a recording and a
transcript on disk. This is what makes a prompt or model change verifiable
before it reaches a real call, and it is the dev loop for client 2 before any
of their infrastructure exists.

**Deployment is unchanged.** `.clasp.json` has `rootDir: ""` and
`skipSubdirectories: false`, so `src/core/` pushes exactly as `src/llm/` did.
CI runs `clasp push -f`, which force-syncs and removes remote files absent
locally, so the moved files leave no stale duplicates defining the same
functions twice. Function declarations hoist across the concatenated scope, so
call order is safe; every top-level `var` under `core/` is a literal, a
`RegExp`, or an object literal over hoisted function declarations, so the move
cannot reorder an initialisation dependency.

**The boundary can still be crossed, and will be caught.** The guard is a test,
not a compiler. It runs on every push, it fails loudly, and its allowlist is
short enough that growing it shows up in review.

**Injection is visible at every call site.** `deps` and `config` are threaded
explicitly rather than resolved from a module-level singleton. That is more
typing and it is the point: a call that lost its HTTP client fails at the
boundary with a named error instead of silently returning an empty extraction
that reads as a bad call.

## Alternatives considered

**A module system or bundler for the Apps Script sources.** Rejected. It buys
real encapsulation, and it costs a build step in a project whose deploy is
`clasp push` and whose debugging surface is the Apps Script editor. The guard
test buys most of the same safety for none of that.

**A single `core.run` entry point, no exported steps.** Rejected, because the
six-minute execution cap makes the two-stage runner load-bearing. See section 4.

**Injecting a logger only, and letting core read config directly.** Rejected.
`getConfig` reaches `PropertiesService`, so config is not a smaller leak than
logging — it is the same leak wearing a different name.

**Porting to Supabase Edge Functions now.** Out of scope and explicitly a
non-goal of spec 021. This decision makes that port possible later; it does not
perform it, and no second runtime runs in production.
