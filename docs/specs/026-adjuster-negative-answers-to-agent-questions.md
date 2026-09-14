# Adjuster extraction — a negative answer is an answer

**Status:** Proposed
**Owner:** Adjuster MVP
**Last updated:** 2026-09-14

## Objective

Three fields have no reachable "this section does not apply" path on the normal
flow: `mitigation_status`, `overhead_profit_narrative`, and `subrogation_reason`.
The intake agent asks each section as a question, the adjuster answers "no", and
all three either flag `[NEEDS INPUT]` or render text that reads as broken. Fix
the extraction guidance so a negative answer is extracted as the answer it is.

## Non-goals

- Changing `enums.json`, the live Google Doc, or any rendered template sentence.
  Every change here is to `prompt.js` guidance, so nothing needs a Drive sync and
  no rendered output changes shape for a claim that was already extracting
  cleanly.
- Changing `buildSpanHaystack()`. A `source_span` stays adjuster-only. See the
  decision below.
- Changing the Dograh/Retell agent script or the questions it asks.

## Business Rationale

On the live Q&A flow the agent asks "Was mitigation involved?", "Can you explain
the overhead and profit considerations for this claim?", and "Are there any local
regulations or subrogation concerns that might affect this claim?"
(`template/dograh-script.md:121,135,137`). The ordinary answer to all three is
no. That is the common case, not an edge case, and today it costs Brandon three
hand-filled fields on most reports.

### Why each one fails

**`mitigation_status`** has a canned negative branch (`none` renders "No
mitigation services were performed on this loss.") but is unreachable from a
bare "No". The system prompt requires an affirmative statement — _"the roof was
not affected", "there is no mortgage"_ — before a status variant may be set, and
a one-word answer is not that shape. It is also one of only four status variants
with no per-field guidance at all.

**`overhead_profit_narrative`** has no negative branch. Its guidance explicitly
rejects the natural answer: _"'Overhead and profit do not apply.' and 'No
overhead and profit considerations.' are both incomplete."_ Given a bare "no",
the model must either invent a reason it was never given or leave the field
empty.

**`subrogation_reason`** has no negative branch, and its current fallback is
worse than a blank. The guidance tells the model to write "an absence of any
identified subrogation potential", which renders as:

> There are no subrogation possibilities as the damages are an absence of any
> identified subrogation potential.

The template sentence already asserts there are no subrogation possibilities.
The slot carries the _reason_, which is the cause of loss ("weather related").

### The framing bug underneath all three

`resolveExtractionTranscript()` passes the **full** master transcript to the
model and only the adjuster-turn projection to `validateFields`:

```js
return { source: 'master', transcript: masterText, haystack: buildSpanHaystack(masterText) }
```

`transcription.test.ts` pins this — `expect(input.transcript).toContain('adjuster: ')`.
The agent's turns are in front of the model. But `TRANSCRIPT_SOURCE_FRAMING.master`
tells it the opposite: _"It has already had the automated intake agent's turns
removed — every line is the adjuster's own words."_

So the model is told every line is the adjuster's, then shown a transcript where
half the lines are the agent's, and given no instruction on how to use a question
it is told is not there. A one-word answer is unreadable without it.

## Architecture

### Decision: the span stays adjuster-only; the framing tells the truth instead

The obvious fix — let the `source_span` cover the question _and_ the answer, so
the citation carries its own context — is rejected. `buildSpanHaystack()` keeps
adjuster turns only, so such a span fails `spanExistsInTranscript()` and the field
renders `[NEEDS INPUT]`: the exact symptom being fixed. Widening the haystack to
admit agent turns reverses spec 022, which was written after call
`retell-call_4e034d77224863af06b4fc2577c` produced a high-confidence match to the
wrong claim by reading an agent's guess back as evidence. A wrong-claim report is
the worst failure this product has.

The context the agent's question carries is real and worth keeping. It is already
available to the model. The fix is to stop telling the model it isn't, and to say
plainly what the two speakers are for: read the agent for context, cite only the
adjuster.

### Decision: `subrogation_reason` echoes the cause rather than gaining a variant

The alternative was a `subrogation_status` variant matching the six other
`<thing>_status` gates. Rejected as unnecessary: the template sentence is already
the negative branch. The only thing missing is where the reason comes from on a
no-subrogation call, and the answer is the cause of loss the call already
established for `origin_narrative`. This keeps `enums.json` and the live Doc
untouched.

## Phases

### Phase 1 — The master framing describes the transcript the model receives

`TRANSCRIPT_SOURCE_FRAMING.master`: drop the false "turns removed" claim. State
that both speakers are present and labelled, that the agent's turns are context
(they are what tells you which question a short answer belongs to), and that a
span drawn from an agent turn invalidates the field.

### Phase 2 — A direct answer is an affirmative statement

The status-variant rule: a one-word answer to a direct question is an affirmative
statement, and the span is the adjuster's answer turn, never the agent's question.
Silence — a section nobody raised, or a question talked past — still returns empty.

### Phase 3 — Per-field negative paths

- `mitigation_status`: new guidance. A negative answer maps to `none`, which is
  complete on its own and needs no `mitigation_narrative`.
- `overhead_profit_narrative`: the determination-plus-reason requirement is scoped
  to a determination the adjuster reasoned about. A bare "no" is his determination:
  write "Overhead and profit are not included on this loss."
- `subrogation_reason`: a negative answer does not go in the slot. Echo the cause
  from `origin_narrative`, cite the cause-of-loss passage.

## Verification

`tests/unit/adjuster/prompt.test.ts`:

- both speakers described, agent read for context, no "turns removed" claim
- a span is still never drawn from an agent turn (spec 022 holds)
- silence still returns empty
- each of the three fields carries its negative path
- `overhead_profit_narrative` keeps the reason requirement for the reasoned case
- the "absence of any identified subrogation potential" wording is gone

Prompt guidance is not mechanically checkable beyond its presence in the built
prompt — these assert the wording reaches the model. Behavioural confirmation
needs a replay against a real call with a negative section answer, which needs
the production Drive artifacts and cannot run from this checkout.

## Backwards compatibility

No schema, template, or rendered-sentence change; `enums.json` and the live Doc
are untouched, so no Drive sync is required. The changed surface is extractor
guidance, which affects future extractions only. A call that already extracted
these three fields cleanly extracts them the same way — the new guidance adds a
path where there was none rather than redirecting an existing one. The one
deliberate output change is `subrogation_reason` on a no-subrogation call, which
moves from "an absence of any identified subrogation potential" to the cause
clause; that sentence is defective today, so every change to it is an improvement.
