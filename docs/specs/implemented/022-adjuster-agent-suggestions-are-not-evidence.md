# Adjuster match integrity — an agent suggestion is never evidence

**Status:** Implemented — [PR #56](https://github.com/Blaze212/fractional/pull/56)
**Owner:** Adjuster MVP
**Last updated:** 2026-09-12

## Objective

The intake agent opens every call by reading back a guessed claim ("Are you
calling about the property on Maple Street in Locust for RAY?"). When the
adjuster says no, that guess stays in the transcript, and `matcher.js` then
scores it as if the adjuster had said it. On call
`retell-call_4e034d77224863af06b4fc2577c` this produced a **high-confidence match
to the wrong claim** and a filed-shape report drafted against an insured the
adjuster had explicitly rejected. This spec makes every stage of the match and
extraction path read only the adjuster's own words, so a rejected suggestion can
never become the claim.

## Non-goals

- Changing what the pre-call hook suggests, or removing the suggestion from the
  call. The read-back is useful and stays.
- Changing the Retell agent prompt or the Dograh workflow.
- Fixing `retell-call_d108ba13cf00804a35b458f5f10`'s stuck `transcribing` status
  (3 attempts, live lease, no master). Real, unrelated, tracked separately.
- Reconciling ASR disagreement on proper nouns (the raw Retell transcript has
  "Kannapolis" where the master has "Annapolis"). Out of scope.

## Business Rationale

The pipeline currently contains a closed feedback loop: `buildClaimSuggestionContext()`
injects the most recently completed appointment into the call as
`suggested_insured_last_name` / `suggested_address_line1` / `suggested_city`, the
agent speaks it, the transcript records it, and `matcher.js` reads it back as
evidence for that same claim. The system confirms its own guess, and it does so
at `match_confidence: high`.

A wrong-claim report is the worst failure this product has. It is not a blank
field costing a few seconds of review; it is a finished draft with a real
insured's name on it, carrying another insured's inspection findings. The
extraction stage already noticed and did nothing useful about it, which is
covered in Phase 4.

### The observed failure, in full

Call `retell-call_4e034d77224863af06b4fc2577c`, 2026-09-07. Raw Retell
transcript, first four turns:

```
Agent: Hi, I'm here to record your field notes. Say "let's get started" to begin.
User: Let's get started.
Agent: Are you calling about the property on Maple Street in Locust for RAY?
User: No.
Agent: Sorry, didn't catch that. What's the property address, and what's the insured's last name?
User: Property address is 1003 Venus Street, Kannapolis, North Carolina 28083. Insurance last name is Arnold.
```

The adjuster said **No**, then gave a different address and a different insured.
There is no Arnold / Venus Street row in the Claims tab, so the correct outcome
is `match_method: none`.

What the Jobs row actually recorded:

| column             | value                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| `claim_id`         | `4gtvsif281k28jb157ii3ibcf1@google.com` (RAY, 502 Maple Street, Locust) |
| `match_method`     | `identity`                                                              |
| `match_confidence` | **`high`**                                                              |
| `doc_url`          | a generated draft against the RAY claim                                 |

Reproducing `scoreClaim()` against that transcript gives RAY 75 points, from
`insured_last_name` (40) + `street_name` (25) + `city` (10). Every one of those
three signals comes from the agent turn the adjuster rejected. Because
`signals.insured_last_name` is set and `hasAddressSignal()` is true,
`confidenceFor()` returns `high`. Because `match_method` is then `identity` and
not `none`/`ambiguous`, `resolveClaimMatch()` never falls through to
`matchClaimWithLlm()`. The LLM matcher, and any prompt change made to it, never
runs on this class of failure at all.

## Architecture

### Decision: matching reads a speaker-scoped projection, not the raw string

`matchClaim()` takes one flat string and `indexOf`s claim identity values into
it. It has no way to know who spoke. The fix is a projection applied before
scoring, not a change to the scoring itself: `matcher.js` stays a pure function
over a string, and the string it gets stops containing the agent's words.

Three label vocabularies exist today and all three are recognizable:

| source              | labels                 | where                                   |
| ------------------- | ---------------------- | --------------------------------------- |
| Retell `call_ended` | `Agent:` / `User:`     | `job.transcript`, stage A               |
| Dograh notetaker    | `Q: ` / `A: `          | `stitchAIGatherMessages()` in `util.js` |
| Master transcript   | `agent:` / `adjuster:` | `transcript_master`, stage B            |

A transcript with none of these (a `manual-test-inject` body, a raw ElevenLabs or
Qwen fallback) is a monologue with no agent turns to remove, so the projection
returns it unchanged. **The projection never returns empty for a non-empty
input.** Matching on nothing is a silent regression to `match_method: none` for
every call, which is worse than today's behavior.

### Decision: the fix lands at stage A, on the raw platform transcript

`resolveClaimMatch()` runs in `runMatchStage()` before `runTranscriptionPass()`,
so matching always reads `job.transcript` and the master does not exist yet.
Waiting for the master is not an option, and is not necessary: the raw Retell
transcript is already speaker-labelled.

### Decision: the LLM matcher gets both the rule and the input that makes it checkable

`LLM_MATCH_SYSTEM_PROMPT` does not currently mention that the transcript has two
speakers, and `buildLlmMatchPrompt()` passes the transcript flat. Adding the rule
without the labels would be unenforceable, so both change together.

### Decision: the model reports rejections, code enforces them

Rather than trusting the model to have excluded a rejected claim, the match
schema gains `rejected_values`, and the candidate pool is filtered against it in
code. This mirrors `checkVerbatimCoverage()` in `masterTranscript.js`: the prompt
produces a fact, and the code enforces the consequence.

### ADR

Phase 1 changes what the matcher is allowed to read, which is a behavior change
to the core claim-identity path. File `docs/adr/008-match-reads-adjuster-turns-only.md`.

## Implementation Phases

### Phase 0 — Fixtures and failing tests

- Add `tests/unit/adjuster/fixtures/` with the three calls already pulled:
  - `retell-call_4e034d77224863af06b4fc2577c` — raw + master. The rejected
    suggestion. Expected outcome after the fix: `match_method: none`.
  - `retell-call_256aa200fdd679f4b7d680cb968` — raw + master. Control. The
    adjuster states identity himself; W.F. Harris Development at 1310 Airport Rd,
    Monroe. Must stay matched, with unchanged score and confidence.
  - `retell-call_d108ba13cf00804a35b458f5f10` — raw only (no master exists).
    Second control, and the only Dograh-shaped `Agent:`/`User:` fixture with no
    matching claim in the sheet. Already `none`, must stay `none`.
- Add a trimmed Claims fixture carrying the rows those three calls score
  against, including RAY / 502 Maple Street / Locust.
- Write the tests first, red. `matcher.test.ts` asserting c1 currently returns
  RAY at `high` is the regression proof; invert it in Phase 1.
- No source changes.

### Phase 1 — Matching reads adjuster turns only

- Add `adjusterTurnsOf(text)` to `transcription.js`. Detects the label
  vocabulary from the leading tokens of each line, returns the concatenated
  adjuster/User/A lines, and returns the input unchanged when no vocabulary is
  recognized.
- `resolveClaimMatch()` in `runner.js` passes `adjusterTurnsOf(job.transcript)`
  to both `matchClaim()` and `matchClaimWithLlm()`.
- Log `runner.match_input` with `{capture_id, label_vocabulary, full_chars,
adjuster_chars}` so a transcript whose labels stopped being recognized is
  visible rather than silent.
- Tests: c1 scores zero identity signals and returns `none`; c2 and c3 are
  byte-identical before and after; an unlabelled monologue is passed through
  untouched; a transcript that is entirely agent turns returns the input
  unchanged rather than empty.

Verified offline against the real fixtures before writing this spec:

| call | today                                                                 | with the projection         |
| ---- | --------------------------------------------------------------------- | --------------------------- |
| c1   | RAY = 75 `[insured_last_name, street_name, city]` → identity/**high** | **no signals → `none`**     |
| c2   | W.F. Harris = 60 `[street_number, street_name, city]` → identity/low  | unchanged, 60, identity/low |
| c3   | no signals → `none`                                                   | unchanged, `none`           |

### Phase 2 — The LLM matcher is told there are two speakers

- `buildLlmMatchPrompt()` renders the transcript as labelled turns instead of
  flat text.
- Extend `LLM_MATCH_SYSTEM_PROMPT`:
  - The transcript is a conversation between an automated intake agent and a
    human adjuster.
  - The agent routinely proposes a claim, address, or contact, drawn from a
    calendar guess. An agent proposal is never evidence.
  - Only the adjuster's own words support a match.
  - A value the adjuster rejects, corrects, or contradicts is disqualified, even
    when it is the only candidate that fits.
  - When the adjuster corrects the agent, the correction supersedes everything
    said earlier in the call.
  - Return an empty `claim_id` in preference to a candidate resting on an agent
    turn.
- Extend the response schema with `rejected_values: string[]` (addresses, names,
  and claim numbers the adjuster explicitly denied) alongside `claim_id` and
  `reasoning`.
- In `matchClaimWithLlm()`, drop any candidate whose `insured_last_name`,
  `address_line1`, or `claim_number` normalizes into a `rejected_values` entry,
  before reading `claim_id`. A `claim_id` naming a filtered candidate is treated
  the same as a hallucinated one: no match.
- Tests: the c1 fixture through a stubbed OpenRouter response returns `none` even
  when the model names RAY; the prompt contains speaker labels; a
  `rejected_values` entry removes its candidate from the pool.

### Phase 3 — An address-only win goes to adjudication

`resolveClaimMatch()` currently consults the LLM only on `none` or `ambiguous`.
Add one more trigger: the winner's signals include neither `claim_number` nor
`insured_last_name`. That is the exact shape of a match resting on a spoken
address, which is the shape a read-back suggestion produces.

- Deterministic result stands if the LLM call fails, as today.
- Log `runner.llm_match_attempted` with the trigger reason.
- Tests: an address-only winner triggers adjudication; a claim-number winner does
  not; c2 (which has address signals only) triggers it and survives it.

### Phase 4 — Extraction stops treating the claim context as ground truth

Two independent holes, both defense in depth behind Phases 1 to 3.

**Spans can cite the agent.** `buildSpanHaystack()` strips the `adjuster:` /
`agent:` labels and keeps both speakers' text, so an agent turn is a valid
verbatim `source_span`. The codebase's strongest anti-hallucination guarantee
does not distinguish who spoke. Build the haystack from adjuster turns only, and
state the rule in `prompt.js`: a `source_span` is drawn from an adjuster turn,
never an agent turn.

**A wrong claim launders itself into the report.** `prompt.js` currently
instructs the extractor to treat the claim context's insured name as
"authoritative over anything the call's voice-to-text produced." Under a wrong
match that instruction actively writes the wrong name into the draft. Add a
precondition: the claim context is a hypothesis about which claim this is, and
its authority over spelling applies only where the adjuster's own words already
corroborate the claim identity. If the adjuster named a different insured or
address, or rejected the one the agent proposed, the claim context loses
authority entirely.

**The mismatch note is not enough on its own.** On c1 the extractor did notice,
and wrote:

> "The transcript identifies the insured as Arnold and the property as 1003
> Venus Street, Annapolis, North Carolina 28083, which does not match the claim
> context identifying Psalm Ray at 502 Maple Street, Locust, North Carolina."

It then generated the document anyway, and the job went to `done`. An identity
mismatch flagged at extraction must set `status: needs_review` and skip document
generation. A draft nobody can trust should not exist in the folder next to
drafts that can be.

- Tests: an agent-turn span is rejected by `validateFields`; the c1 extraction
  fixture routes to `needs_review` with no `doc_url`; a corroborated claim
  context still wins on spelling.

## Edge Cases & Risk

| Risk                                                                                   | Likelihood | Impact | Mitigation                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A platform changes its label format and the projection silently empties the transcript | M          | H      | Projection returns input unchanged when no vocabulary matches; `runner.match_input` logs the detected vocabulary and both char counts                                 |
| Adjuster confirms the suggestion instead of restating it ("yes, that's the one")       | M          | M      | Phase 1 correctly yields `none` rather than a wrong match. Degrades to unmatched, which is safe and visible. Handling affirmative confirmation is deferred, see below |
| Adjuster repeats the wrong address in order to reject it ("no, it's not Maple Street") | L          | H      | Phase 2's `rejected_values` filter, which operates on adjuster turns                                                                                                  |
| Phase 4's `needs_review` gate strands jobs Brandon expected as drafts                  | M          | M      | Only fires on a detected identity mismatch; the note naming both identities is already written to the artifact                                                        |
| Short last names substring-match inside ordinary words (`RAY` inside `spray`, `array`) | L          | H      | Not the cause of c1, and not fixed here. Deferred, see below                                                                                                          |

## Acceptance Criteria

- [x] `adjusterTurnsOf()` handles all three label vocabularies and passes
      unlabelled text through unchanged
- [x] Replaying `retell-call_4e034d77224863af06b4fc2577c` yields
      `match_method: none` and no generated document — verified against a
      reconstructed fixture (`tests/unit/adjuster/fixtures/matchIntegrity.ts`),
      not a live replay against the production Drive/Sheets recording, which
      this environment has no access to; c1's raw opening is quoted verbatim
      from this spec. "No generated document" means no draft carrying the
      wrong insured's name — an unmatched call still generates a draft with
      blank claim-identifying fields, unchanged pre-spec behavior for any
      `match_method: none` call.
- [x] Replaying `retell-call_256aa200fdd679f4b7d680cb968` and
      `retell-call_d108ba13cf00804a35b458f5f10` yields byte-identical match
      results to today — same fixture-reconstruction caveat as above; both are
      built to reproduce the documented score/method/confidence shape rather
      than replaying the real recordings.
- [x] `buildLlmMatchPrompt()` output contains speaker labels
- [x] A `rejected_values` entry removes its candidate before `claim_id` is read
- [x] An address-only deterministic winner triggers LLM adjudication
- [x] A `source_span` drawn from an agent turn fails validation
- [x] An extraction-stage identity mismatch sets `status: needs_review` and
      writes no `doc_url`
- [x] ADR filed at `docs/adr/009-match-reads-adjuster-turns-only.md` — 008 was
      already taken by `telnyx-retired` by the time this spec was implemented
- [x] `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm lint` pass

## Deferred

- **Affirmative confirmation of a suggestion.** "Yes, that's the one" is
  currently indistinguishable from silence once agent turns are removed, so
  those calls land on `none`. Safe, but it loses a match the system could make.
  Worth a follow-up that treats an adjuster's affirmative reply as adopting the
  agent's proposed identity.
- **Word-boundary matching in `containsValue()`.** `indexOf` means `RAY` matches
  inside `spray`, `gray`, and `array`, and `LOVE` inside `glove`. It is not what
  broke c1, and fixing it alongside a projection change would make the c2 and c3
  control results harder to attribute. Separate change, separate proof.
