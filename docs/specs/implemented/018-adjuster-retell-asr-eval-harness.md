# Adjuster Retell ASR Comparison Harness

**Status:** Implemented — completed 2026-08-31
**Owner:** Barton
**Last updated:** 2026-08-31

## Objective

Brandon's adjuster voice-agent pipeline runs three ASR sources today: Retell's
built-in real-time speech-to-text (streaming, live on the call), and two batch
transcription sources run after the call — ElevenLabs Scribe and Qwen3 ASR
(`scripts/elevenlabs-transcribe.mjs`, `scripts/stt-transcribe.mjs`). We don't
know whether Retell's ASR is accurate enough on insurance vocabulary (roofing
trade terms, claim terms, and call-specific proper nouns like names/insurers/
street addresses) to potentially displace one of the batch sources, or whether
it should stay limited to the real-time slot only. Build a scoring harness
that takes a set of calls — each with a human-verified reference transcript
and the three ASR outputs for the same audio — and scores each source's
vocabulary accuracy against `apps/adjuster/template/glossary.json`'s trade
terms plus each call's proper nouns. Word-level match/miss per term, not
overall WER, since the risk that matters here is a missed insurance term, not
generic transcription noise.

## Non-goals

- Placing real comparison calls or collecting real transcripts. No live call
  data exists yet — this spec ships the harness only.
- Deciding whether Retell displaces a batch source or stays streaming-only.
  That decision is explicitly deferred to Barton running the harness against
  ~10 real calls (see Acceptance Criteria).
- General-purpose WER (word error rate) scoring. Out of scope — the harness
  is deliberately narrow to insurance-vocabulary accuracy, which is the
  specific risk this evaluation is trying to de-risk.
- Wiring the harness into the live pipeline (`runner.js`, `webhook.js`, or
  any Apps Script code). This is an offline, standalone `scripts/` tool, same
  pattern as `stt-transcribe.mjs` and `elevenlabs-transcribe.mjs` — not
  reachable from the adjuster app at runtime.
- Automatically fetching Retell's transcript from its API. Retell transcripts
  are pasted/exported into the manifest like the other two sources; no new
  Retell API integration is built here.
- Fuzzy/phonetic matching (e.g. "drip edge" vs. "trip edge"). Match is exact
  on normalized text — good enough to rank three sources against each other,
  and simpler to reason about and test.

## Business Rationale

Every batch transcription source costs money and adds latency to draft
generation. If Retell's live ASR is already accurate enough on the
vocabulary that actually matters for this product — trade terms and
call-specific names/addresses/insurers — one of ElevenLabs or Qwen could be
dropped, cutting cost and one hop of latency. If it isn't, Retell stays
scoped to the real-time/streaming slot only (where it already runs) and both
batch sources stay in place. Either way this is a data-driven call, not a
guess — but no data exists yet. This spec builds the tool that will produce
that data; it does not produce the data itself.

## Architecture

### Where "proper nouns" come from

`apps/adjuster/template/glossary.json` is a static, call-independent list of
roofing/insurance trade terms (`{ term, definition }`, currently 90-some
entries — "drip edge", "ridge cap", "RCV", "coinsurance penalty", etc.). It
has no proper nouns and no category field, because proper nouns (the
policyholder's name, the insurer's name, the street address) are different
for every call — they can't live in a static glossary. Each call fixture in
the harness's input manifest therefore carries its own `properNouns: string[]`
list, supplied by whoever built that fixture (Barton, since he's the one who
knows what was actually said on a real call). The harness merges
`glossaryTerms ∪ call.properNouns` as the candidate vocabulary for that call,
then narrows to the subset that actually occurs in that call's reference
transcript (a call about roof damage won't mention "coinsurance penalty", and
scoring a source as "missing" a term that was never said would be wrong).

### Input shape: a JSON manifest, not raw audio

The harness does not touch audio or call Retell/ElevenLabs/Qwen's APIs
itself — those are separate steps run by hand (Retell's transcript is copied
from its dashboard/API response; ElevenLabs and Qwen already have runners in
`scripts/`). Input is a JSON manifest, one entry per call, each field a file
path (resolved relative to the manifest file) to a plain-text transcript —
matching the `.txt` transcripts `stt-transcribe.mjs` and
`elevenlabs-transcribe.mjs` already produce in `scripts/transcripts/`:

```json
[
  {
    "callId": "call-001",
    "reference": "./call-001/reference.txt",
    "retell": "./call-001/retell.txt",
    "elevenlabs": "./call-001/elevenlabs.txt",
    "qwen": "./call-001/qwen.txt",
    "properNouns": ["Dana Whitfield", "Meridian Mutual", "Oak Hollow Drive"]
  }
]
```

`reference` is a human-verified transcript of what was actually said on the
call — the ground truth the three ASR outputs are scored against. It is not
produced by any ASR source; Barton writes/corrects it by listening to the
recording, same as any transcription-accuracy eval needs a ground truth.

### Pure scoring core, thin CLI shell

Same split as `stt-transcribe.mjs`: every scoring function is pure (plain
strings/objects in, plain objects out, no filesystem access), fully unit
testable with in-memory fixtures. `main()` is the only impure part — it reads
the manifest and glossary files, calls the pure functions, and writes/prints
the report. Exported functions (`scripts/adjuster-asr-eval.mjs`):

- `normalizeForMatch(text)` — lowercase, strip punctuation (hyphens
  included, since ASR sources are inconsistent about hyphenating compound
  terms like "3-tab shingle" — "3-tab" and "3 tab" must compare equal),
  collapse whitespace. Used on both terms and transcripts before matching.
- `extractGlossaryTerms(glossary)` — `glossary` is the parsed
  `glossary.json` array; returns `string[]` of `.term` values.
- `termOccursIn(term, transcriptText)` — word-boundary-safe substring check
  on normalized text (`\bridge\b` must not match inside a single word like
  "fridge", but it does match inside "ridge cap" since "ridge" is itself a
  standalone word there — both terms legitimately score independently; see
  the Edge Cases table below). The multi-word term `ridge cap` separately
  matches its own literal phrase, in word order. Both `term` and
  `transcriptText` are normalized via `normalizeForMatch` before comparison.
- `findExpectedTerms({ referenceText, glossaryTerms, properNouns })` — the
  subset of `glossaryTerms ∪ properNouns` that actually occurs in
  `referenceText`. This is "what vocabulary this specific call actually
  exercises" — the denominator for every source's score on this call.
- `scoreTranscript({ transcriptText, expectedTerms })` — for each expected
  term, checks `termOccursIn`. Returns
  `{ matched: string[], missed: string[], accuracy: number }` (`accuracy` is
  `matched.length / expectedTerms.length`, or `1` when `expectedTerms` is
  empty — no vocabulary to miss).
- `scoreCall(call, glossaryTerms)` — `call` is one manifest entry with
  transcript _text_ already loaded (not file paths — that resolution is
  `main()`'s job). Computes `findExpectedTerms` once, then
  `scoreTranscript` for each of `retell` / `elevenlabs` / `qwen`. Returns
  `{ callId, expectedTerms, sources: { retell, elevenlabs, qwen } }`.
- `aggregateBySource(callScores)` — micro-averages across all calls per
  source: `sum(matched) / sum(expected)` (weights calls by how much
  vocabulary they actually contain, rather than treating a 2-term call and a
  20-term call equally). Returns
  `{ retell: { matched, expected, accuracy }, elevenlabs: {...}, qwen: {...} }`.
  Calls with zero expected terms are excluded from the aggregate (nothing to
  score) but still appear in the per-call report output with a note.
- `rankSources(aggregate)` — returns the three sources sorted by `accuracy`
  descending, `[{ source, accuracy, matched, expected }, ...]`.
- `renderMarkdownReport({ callScores, aggregate, ranking, meta })` — markdown
  string: a ranking summary table, then a per-call table of matched/missed
  terms per source. `meta` carries `{ generatedAt, glossaryPath, callCount }`
  for the report header.

### CLI

```
node scripts/adjuster-asr-eval.mjs --calls path/to/manifest.json \
  [--glossary apps/adjuster/template/glossary.json] \
  [--out report.md] [--format md|json]
```

- `--calls` (required) — path to the manifest JSON above.
- `--glossary` — defaults to `apps/adjuster/template/glossary.json`.
- `--out` — file to write the report to; defaults to stdout.
- `--format` — `md` (default) or `json` (raw `{ callScores, aggregate,
ranking }` for downstream tooling).

Zero dependencies, Node 20+ built-ins only (`node:fs`, `node:path`), matching
the existing `scripts/*.mjs` convention. Not wired into `pnpm` scripts or the
app — run directly, same as `stt-transcribe.mjs`.

## Implementation Phases

### Phase 1 — Pure scoring core + unit tests

- `scripts/adjuster-asr-eval.mjs`: `normalizeForMatch`, `extractGlossaryTerms`,
  `termOccursIn`, `findExpectedTerms`, `scoreTranscript`, `scoreCall`,
  `aggregateBySource`, `rankSources`. No CLI/file I/O yet.
- `tests/unit/adjuster-asr-eval.test.ts`: in-memory fixtures — a small
  made-up glossary (a handful of terms), 2-3 realistic call fixtures with
  reference + three source transcripts each deliberately varying (one source
  gets a term right, another mishears a proper noun, one drops a multi-word
  term), covering: normalization (punctuation/case/hyphen handling),
  word-boundary correctness (no false-positive substring matches),
  `findExpectedTerms` narrowing to only what's in the reference,
  per-source accuracy computation, zero-expected-terms edge case, and
  aggregate micro-averaging across multiple calls.

### Phase 2 — CLI + markdown report generator

- `renderMarkdownReport` and the `--format json` path.
- `main()`: arg parsing, manifest loading (resolve each transcript path
  relative to the manifest file, read as text), glossary loading, wiring the
  Phase 1 functions together, writing to `--out` or stdout.
- Unit tests: `renderMarkdownReport` output shape (ranking table present,
  per-call rows present, missed terms listed) against an in-memory
  `callScores`/`aggregate`/`ranking` fixture — no file I/O in tests, same as
  Phase 1.
- Manual smoke test only (not a unit test, since it touches the filesystem):
  a throwaway manifest + a few `.txt` fixture files, run the CLI, confirm it
  produces a sane report.

## Edge Cases & Risk

| Risk                                                                                        | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A glossary term is itself a substring of another glossary term ("ridge" inside "ridge cap") | H          | L      | Both terms score independently and both are legitimately "in the call" if "ridge cap" was said — this double-counts related terms rather than hiding a bug. Documented behavior, not a defect; a future refinement could dedupe overlapping terms if it proves noisy in practice |
| Manifest references a transcript file that doesn't exist                                    | M          | M      | `main()` throws a clear "file not found" error naming the call and field, rather than silently scoring an empty transcript                                                                                                                                                       |
| A call's reference transcript contains none of the glossary/proper-noun vocabulary          | L          | L      | `findExpectedTerms` returns `[]`; `scoreTranscript` reports `accuracy: 1` (nothing to miss) but the call is excluded from the aggregate denominator so it can't inflate or deflate the ranking                                                                                   |
| Punctuation/casing differences between reference and ASR output cause false misses          | H          | M      | `normalizeForMatch` strips punctuation and case before comparison on both sides                                                                                                                                                                                                  |
| Proper nouns are call-specific and easy to forget when building a fixture                   | M          | M      | Manifest schema requires `properNouns` per call explicitly (empty array if truly none), rather than only relying on the shared glossary                                                                                                                                          |
| Ranking is based on only ~10 calls — small sample, easy to over-read                        | M          | H      | Called out explicitly in Acceptance Criteria and the eventual report: this harness produces a directional signal from a small sample, not a statistically definitive verdict                                                                                                     |

## Acceptance Criteria

- [ ] `scripts/adjuster-asr-eval.mjs` exports pure, file-I/O-free scoring
      functions per the Architecture section
- [ ] `tests/unit/adjuster-asr-eval.test.ts` covers normalization,
      word-boundary matching, `findExpectedTerms` narrowing, per-source
      scoring, the zero-expected-terms edge case, aggregate micro-averaging,
      and the markdown report's output shape — all against in-memory
      fixtures, no real call data
- [ ] CLI (`--calls`, `--glossary`, `--out`, `--format`) runs end-to-end
      against a manifest of `.txt` fixture files and produces a markdown
      report ranking the three sources
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` all pass
- [ ] No hardcoded secrets; no dependency on live Retell/ElevenLabs/Qwen API
      calls from this script
- [ ] **This PR does not include real ASR comparison results or a
      streaming-only-vs-displace-a-batch-source decision.** No live
      comparison calls have been placed. The Acceptance Criteria for that
      decision are explicitly deferred: Barton places ~10 real calls, builds
      a manifest from the resulting Retell/ElevenLabs/Qwen transcripts plus a
      hand-verified reference transcript per call, runs this harness, and
      only then is the streaming-only-vs-displace-a-batch-source call made —
      as a separate follow-up, not part of this spec
