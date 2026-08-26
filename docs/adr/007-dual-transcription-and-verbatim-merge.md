# ADR 007 — Dual Batch Transcription, a Direct ElevenLabs Call, and a Merge Model Constrained to Verbatim Selection

**Status:** Accepted
**Date:** 2026-08-26
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/012-dual-transcription-master-transcript.md

---

## Context

A Dograh Notetaker call produces exactly one transcript: Dograh's own real-time
Deepgram stream. Every extracted field in the draft report is validated against
it. That transcript is the weakest link in the pipeline — it hears the call once,
at streaming latency, over a lossy mobile codec, from a moving vehicle, with no
second pass. Proper nouns (insured names, carriers, street names) and trade terms
(drip edge, pipe boot, 6/12 pitch) are exactly what it gets wrong and exactly
what the report needs right.

Spec 012 adds a batch transcription layer: two independent high-accuracy models
re-read the saved recording, and one model call reconciles those two plus
Dograh's stream into a single master transcript that replaces the Dograh
transcript as the extractor's input.

Two decisions in that design cut against existing rules and are recorded here.

## Decision 1 — ElevenLabs Scribe is called directly, not through OpenRouter

The project rule is that model calls route through OpenRouter
(`.claude/CLAUDE.md`, and the memory note that OpenRouter is the default AI
client). ElevenLabs Scribe v2 is the one exception.

Reasons:

- ElevenLabs Scribe is not available through OpenRouter's STT passthrough.
- The two things this layer most needs from it — speaker diarization
  (`diarize`, `num_speakers`) and keyterm biasing (`keyterms`) — are
  ElevenLabs-native request parameters with no OpenRouter equivalent.

Scope of the exception:

- It is the only direct-vendor model call in the codebase.
- It is confined to one file, `apps/adjuster/src/transcription.js`, behind
  `buildElevenLabsRequest()`.
- Qwen3 ASR Flash still goes through OpenRouter's `/audio/transcriptions`
  endpoint, and the merge call still goes through `callOpenRouter()`.
- `ELEVENLABS_API_KEY` is an Apps Script property, sent as the `xi-api-key`
  header, and never logged.

Consequence accepted: a second vendor now processes claim data. The keyterm list
carries the insured's last name, street address, city, carrier, and claim number.
Those already leave the system to OpenRouter in the extraction prompt today, so
this is a new processor of data that was already leaving, not a new class of
disclosure — but it is a real second vendor touching claim data and Brandon
should know it.

## Decision 2 — The merge model may not author words, and that is enforced mechanically

`validateFields()` accepts a field only when its `source_span` is a verbatim
substring of the transcript. That is this codebase's single strongest
anti-hallucination guarantee: a field cannot reach the report unless the words
supporting it were actually in machine-transcribed audio.

Feeding the extractor a model-authored master transcript would quietly downgrade
that guarantee to "the extractor invented nothing the _merge_ model had not
already invented". So the merge model is constrained to selection, not
composition: for every passage it must choose one of the three transcripts'
wordings character for character, may drop pure transcription noise, and may add
speaker labels and line breaks — but may not write a word appearing in none of
them, blend two sources within a phrase, correct grammar, or fix a word it
believes all three got wrong.

A prompt instruction is not a guarantee, so `checkVerbatimCoverage()` in
`apps/adjuster/src/llm/masterTranscript.js` checks it independently: the master
is split into overlapping 8-word shingles and each must appear in at least one
normalized source. At or above 0.98 the master is accepted; between 0.90 and 0.98
it is accepted and flagged; below 0.90 it is rejected and extraction falls back
to the highest-precedence raw ASR transcript.

Rejecting rather than retrying is deliberate. A model that ignored the constraint
once will likely ignore it again, and every fallback target is a raw ASR
transcript — so the span guarantee holds unconditionally on the rejection path.
That is the whole point of falling back to a raw transcript rather than to a
repaired master.

### Deviation from the spec: shingles are built per turn, not across the whole master

Spec 012 says to split "the concatenated master" into shingles. Implemented
literally, that penalises exactly the behavior the design asks for. A turn
boundary is precisely where the merge legitimately switches source, so a window
straddling one is a phrase that by construction exists in no single source. Every
boundary contributes seven guaranteed failures: on a 40-turn call that is roughly
280 failing shingles out of roughly 1500, putting a perfectly faithful merge at
about 0.81 coverage — under the 0.90 gate. Every master would be rejected and the
feature would never do anything.

Shingles are therefore built per turn. The guarantee is unchanged (every word
inside a turn must still come from a source) and the false failures disappear.
The 0.98/0.90 thresholds and the 8-word width remain as spec'd; both are meant to
be tuned from Phase 3 shadow-run data.

### Consequence for span validation

`validateFields()` is called with a _span haystack_ rather than the rendered
master: the turn texts joined by newlines with the speaker labels stripped, so a
span can never be satisfied by text the merge model added. The extraction prompt
gains one sentence requiring a `source_span` to lie inside a single turn, applied
only when the input is a merged master. A span straddling a turn boundary fails
validation and the field becomes `[NEEDS INPUT]` — the safe direction.

## Alternatives considered

- **One batch model instead of two.** Cheaper, but a single batch reading has no
  cross-check: its systematic errors would land in the master unchallenged. The
  second model exists to make disagreement visible, and `contested_passages`
  records where it happened.
- **Let the merge model write freely and re-validate spans loosely.** This is the
  option that quietly destroys the span guarantee. Rejected.
- **Repair a low-coverage master with a second merge call.** Costs another call
  to arrive somewhere still unverifiable. Falling back to a raw transcript is
  cheaper and provably safe.
- **Drop Dograh's transcript once batch models exist.** Dograh is the only source
  that knows when the agent spoke, so it stays as the turn-structure skeleton and
  as the last-resort floor — ranked last on wording, not removed.

## Consequences

- Cost rises by roughly $0.10 per call (about $0.045 ElevenLabs, $0.021 Qwen, a
  few cents for the merge) against a running cost of roughly $15/month. The real
  constraint is Apps Script's 6-minute execution cap, not spend, which is why the
  pipeline is split into two status-driven stages.
- `SOURCE_PRECEDENCE` (ElevenLabs, Qwen, Dograh) is a single constant governing
  both merge disagreements and every fallback, so the two cannot drift apart.
  A fixed precedence does mean one vendor's blind spots become the master's;
  `contested_passages` and the per-call manifest are what would show that, and
  the constant is cheap to reorder.
- Rollout is a script property, `MASTER_TRANSCRIPT_MODE`: `off` reproduces
  today's behavior exactly, `shadow` runs everything and writes every artifact
  while leaving the draft on today's input, `live` flips extraction to the
  master. First deploy is `shadow`; revert is a one-property flip.
- The pass is Dograh-only. Telnyx paths (Record, single-stage AIGather, guided)
  are untouched.
