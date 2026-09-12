# ADR 009 — Claim Matching Reads a Speaker-Scoped Projection, Not the Raw Transcript

**Status:** Accepted
**Date:** 2026-09-12
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/022-adjuster-agent-suggestions-are-not-evidence.md

---

## Context

The intake agent opens most calls by reading back a guessed claim ("Are you
calling about the property on Maple Street in Locust for RAY?"), drawn from
`buildClaimSuggestionContext()`'s most-recently-completed-appointment guess.
`matcher.js`'s `matchClaim()` and `llmMatcher.js`'s `matchClaimWithLlm()` both
take one flat transcript string and have no notion of who spoke — `indexOf`
cannot distinguish the agent's proposal from the adjuster's own words.

On `retell-call_4e034d77224863af06b4fc2577c` the adjuster rejected the guess
("No.") and gave a different address and insured. The agent's rejected
sentence still contained the correct claim's proper nouns, `scoreClaim()`
counted them, and the pipeline produced a **high-confidence match to the wrong
claim** — a finished draft carrying one insured's inspection findings under
another insured's name. That is the worst class of failure this product has.

## Decision

Matching reads a speaker-scoped projection of the transcript, computed once at
the top of `resolveClaimMatch()` in `runner.js` and handed to both the
deterministic and LLM matchers: `adjusterTurnsOf(job.transcript)`
(`transcription.js`). `matcher.js` and `llmMatcher.js` are otherwise
unchanged — they stay pure functions over a string; only the string they
receive changes.

`adjusterTurnsOf()` recognizes the label vocabulary of whichever pipeline
stage produced the transcript (`Agent:`/`User:` from Retell's own
`call.transcript`, `agent:`/`adjuster:` from this codebase's own master
transcript, `Q:`/`A:` from Dograh's Notetaker export) from the leading token
of each line, and keeps only the adjuster's lines. A transcript whose
vocabulary isn't recognized — a manual test injection, a raw fallback with no
speaker structure — is passed through unchanged, and so is a transcript that
is entirely agent turns once a vocabulary is detected. **The projection never
returns empty for a non-empty input.** Silently emptying the transcript would
regress every affected call to `match_method: 'none'`, which is a worse
failure than reading the agent's words: it is quiet where a wrong match is
loud, but it still means claims stop matching for a reason nobody would think
to look for.

## Alternatives considered

- **Change `scoreClaim()` to ignore agent-attributable substrings.** Requires
  scoring to know about turn structure, which it currently has no way to
  express — the transcript arrives as one string. Projecting before scoring
  keeps `matcher.js` a pure function over a string, unchanged.
- **Stop the agent from reading back a guess at all.** The read-back is useful
  — it is the fast path when the agent is right — and is explicitly out of
  scope (see the spec's Non-goals). This decision is about what counts as
  evidence, not about what the agent says.
- **Filter in `webhook.js` at ingestion, before `job.transcript` is written.**
  Would lose the agent's turns for every other consumer of `job.transcript`
  (the manifest, replay, a human reading the raw call back) for a benefit
  scoped only to matching. Projecting at the matching call site keeps the
  blast radius to exactly the two functions that needed it.

## Consequences

- A call where the adjuster only ever confirms the agent's guess ("Yes,
  that's the one") rather than restating it now degrades to `match_method:
'none'` — safe, but it loses a match the system could make. Deferred in the
  spec as a follow-up: treating an affirmative reply as adopting the agent's
  proposed identity is a different, additive decision from this one.
- `runner.match_input` is logged on every match attempt with the detected
  vocabulary and both the full and adjuster-only character counts, so a
  platform that changes its transcript format and silently falls through to
  "vocabulary not recognized" is visible in the log rather than only visible
  as a drop in match rate.
- Extraction (`resolveExtractionTranscript()` in `transcription.js`,
  `buildSpanHaystack()` in `llm/masterTranscript.js`) is untouched by this
  decision — it still reads whatever `extraction_input` resolved to. Spec 022
  Phase 4 covers the same "an agent turn is not evidence" property for
  extraction separately, since it is a different code path with a different
  mechanism (`source_span` validation, not `indexOf` scoring).
