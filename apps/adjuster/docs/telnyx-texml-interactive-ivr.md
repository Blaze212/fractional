# Interactive field-notes IVR — Telnyx TeXML research

**Implemented, not live.** `src/guidedFlow.js` builds this design —
section config, all three TeXML verb builders, branch resolution, and
transcript stitching — and `webhook.js` dispatches its events
alongside the existing single-shot ones. `public/texml/guided-intake.xml`
(in `apps/bh-systems`) is the static bootstrap a Telnyx number's Voice
URL would point at to try it; nothing currently does. See
`tests/unit/adjuster/guidedFlow.test.ts` for the behavior this is
actually verified against, and the README's "Phase 2" entry for the
one real deployment prerequisite (a new Jobs sheet column) and the
known gaps left open deliberately since this isn't live yet.

Companion to `template/interactive-call-script.txt`. That file is the
call script; this is the answer to "can Telnyx's infrastructure actually
run it, and how." Short answer: yes, entirely on TeXML — no separate
product needed. Three ways to build it, in increasing order of how much
control you give up to Telnyx's hosted AI.

## How multi-step TeXML actually works (the part that makes this possible)

TeXML documents aren't static — a document is fetched once per _turn_,
not once per call. Every verb that has an `action` attribute (`<Gather>`,
`<Record>`, `<Redirect>`) POSTs its result to that URL, and **whatever
XML your webhook returns becomes the next set of instructions for the
same live call** ("transfers call control to returned TeXML"). That's
exactly the shape `field-notes.xml` already half-uses (`Record`'s
`action` posts to the Apps Script webhook) — it just stops after one
turn today. Chaining N of these together, with your webhook deciding
which section's XML to return next based on what's already been
captured for that `CallSessionId`, is the standard, documented pattern
— not a workaround.
[[TeXML setup](https://developers.telnyx.com/docs/voice/programmable-voice/texml-setup)]

## Approach A — chained `<Record>` per section (closest to what you have)

One short `<Record>` per Ibis section instead of one long one for the
whole call. Apps Script's webhook, on each `action` callback, looks up
the job by `CallSessionId`, marks that section done, and returns a new
`<Response><Say>...next question...</Say><Record action="..."/></Response>`
document for the next section.

- Reuses `webhook.js`, `matcher.js`, `prompt.js`, `openrouter.js` almost
  unchanged — same Deepgram transcription (`transcriptionEngine="deepgram"`,
  `transcriptionModel="deepgram/nova-3"`), same LLM extraction, just run
  per-section instead of on one 900-second blob.
- Directly fixes the class of bug this branch is already named for
  (`fix/adjuster-webhook-logging-and-transcript-loss`): a dropped
  recording/transcript callback now loses one section's audio instead of
  the entire call, and the adjuster can be told "let's redo the roof
  section" instead of the whole thing.
- All 8 `[OPEN]` narrative fields in the script (origin, roof damage,
  exterior, interior, personal property, mitigation, overhead & profit,
  subrogation) fit this directly — no branching logic needed inside the
  verb itself, only in what your webhook returns next.
- Doesn't help with the `[CHOICE]`/`[YES/NO]` fields (mortgage,
  coverage_determination, roof_status, dwelling_stories, etc.) — those
  would still go through Deepgram + your extraction prompt guessing at
  intent from free speech, same as today.

## Approach B — `<Gather>` for choices/branches, `<Record>` for narratives

`<Gather input="dtmf speech">` accepts _either_ a spoken answer or a
keypress and, unlike `<Record>`, resolves directly to a discrete result
your webhook can branch on immediately — no LLM guess required.
[[Gather verb reference](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/gather)]

```xml
<Response>
  <Gather input="dtmf speech" numDigits="1" timeout="5"
          action="https://.../exec?t=SECRET&amp;event=gather&amp;field=roof_status">
    <Say voice="Telnyx.Natural.brook">Roof — affected or not?</Say>
  </Gather>
</Response>
```

Note what's _not_ in that prompt: no "say yes or no," no "press 1 for
X, press 2 for Y." This is a tool one adjuster uses ~15 times a week —
reading a menu of options out loud every call is exactly the kind of
filler that gets unbearable fast. `Gather` accepts DTMF as a fallback
input mode, but that's never spoken; the adjuster just answers in
words and the digit path exists only for a bad connection.

The field-to-verb mapping isn't just "closed set → Gather, free text →
Record" — several closed-set fields have a natural one-breath answer
that also carries an adjacent detail (mortgage status + who the
mortgage is through; coverage determination + the cause; personal
property damaged-or-not + what was damaged). Forcing those into two
separate round-trips ("Do you have a mortgage — yes or no" _then_ "OK,
who's it through") is the same kind of clunky, repetitive exchange the
no-filler rule above is trying to avoid — an adjuster naturally says
"No" or "Yeah, it's through Chase" in one sentence. Those become a
single bundled `<AIGather>` turn instead: one open question, one
schema with both fields (the branch field still typed as a strict
`enum`, so the exact resolved value is preserved — see the trade-off
note under Approach C below), captured in whichever shape the adjuster
happens to answer in.

| `<Gather>` (standalone branch, no natural attached detail) | Bundled `<AIGather>` (branch + detail in one breath)                                                                                                                                                                                                       | Free text (`<AIGather>` string/int, no menu)                                                                                                                                                                                                      | `<Record>` (pure narrative)                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| roof_status, foundation_type, occupancy_status             | mortgage_status + mortgage_company; coverage_cause_narrative + coverage_determination + coverage_supporting_detail; exterior_status + exterior_narrative; personal_property_status + personal_property_narrative; mitigation_status + mitigation_narrative | dwelling_type, dwelling_stories, bedroom_count, bathroom_count, square_footage, year_built, siding_type (grouped as one Risk Information turn); roof_covering_type/condition/age/pitch + roof_damage_narrative (grouped as one Roof-shingle turn) | origin_narrative, roof_narrative_freeform (non-shingle), interior_damage_narrative, overhead_profit_narrative, subrogation_reason, coinsurance_narrative |

`roof_status` stays a standalone `<Gather>` rather than folding into
the roof AIGather turn below it, because it decides _which_ schema the
next turn even uses (shingle vs. non-shingle vs. nothing) — it has to
resolve before the follow-up question can be built, so it can't be
bundled with the thing it's gating.

Since Risk Information is one small cluster of short facts with this
exact free-text problem, it's grouped into a single `<AIGather>`
covering `dwelling_type`, `dwelling_stories`, `foundation_type`,
`square_footage`, `bedroom_count`, `bathroom_count`, `occupancy_status`
in one schema — string/integer fields with example-laden descriptions
for the genuinely free-text ones, `enum` still used for
`foundation_type`/`occupancy_status` since those really are closed.
That also gets you the "did I get everything" completeness check
discussed above for free, in the section with the most required
fields to lose track of (7).

This is the design that's actually built into the script now — a
three-way split by verb, not a straight enum-vs-narrative rule: plain
`<Gather>` where a branch decision stands alone (`roof_status`,
`foundation_type`, `occupancy_status`); bundled `<AIGather>` where a
branch has a natural attached detail (mortgage, coverage, exterior,
personal property, mitigation) or where several free-text facts belong
in one breath (Risk Information, the roof-shingle cluster); plain
`<Record>` for pure narrative with no structure to extract. It still
matches the README's stated design principle: **`coverage_determination`
and `mortgage_status` "stay as `variant` fields... because the blank
template's actual legal-style wording... matters and shouldn't be
reworded by a model."** Bundling them into an `<AIGather>` turn doesn't
give that up, _as long as the branch field stays typed as a strict
`enum` inside the schema_ (see `coverage_determination` in the example
below) — the AI resolves which of the fixed values applies, it doesn't
invent new wording for it. Only the fields sitting _outside_ required
`enum`/`integer` typing in a schema are true free text.

## Approach C — `<AIGather>` per section (Telnyx's hosted slot-filling)

`<AIGather>` is a third TeXML verb, separate from `<Gather>`, built
specifically for this: you hand it a JSON Schema and Telnyx's own
hosted AI conducts the back-and-forth, asks its own follow-up questions
for anything missing, and POSTs structured JSON to your `action` URL
once every `required` field in the schema is filled.
[[AIGather verb reference](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/aigather)]
[[AI-Gather guide](https://developers.telnyx.com/docs/voice/programmable-voice/gather-using-ai/index)]

```xml
<Response>
  <AIGather action="https://.../exec?t=SECRET&amp;event=aigather&amp;section=risk"
            method="POST">
    <Greeting>Give me the dwelling — stories, type, foundation, square
      footage, bedrooms, bathrooms, and who's living there.</Greeting>
    <Parameters><![CDATA[
    {
      "type": "object",
      "properties": {
        "dwelling_stories": {"type": "string", "description": "e.g. 1 story, 2 story, a story and a half — use what the adjuster says"},
        "dwelling_type": {"type": "string", "description": "e.g. single family, duplex, apartment, townhome — use what the adjuster says, don't force a category"},
        "foundation_type": {"type": "string", "enum": ["crawlspace","basement","slab"]},
        "square_footage": {"type": "string"},
        "bedroom_count": {"type": "integer"},
        "bathroom_count": {"type": "integer"},
        "occupancy_status": {"type": "string", "enum": ["the insured","a tenant","tenants"]}
      },
      "required": ["dwelling_stories","dwelling_type","foundation_type",
                   "square_footage","bedroom_count","bathroom_count","occupancy_status"]
    }
    ]]></Parameters>
    <Voice name="Telnyx.Natural.brook"/>
  </AIGather>
</Response>
```

One `<AIGather>` per section, schema built straight from that section's
slice of `enums.json` — this would genuinely replace `prompt.js`'s
post-call LLM extraction for whatever's covered by the schema, live,
during the call, instead of after. It's the most naturally conversational
of the three (it's what you get if you literally translate the
`interactive-call-script.txt` questions into a schema and let Telnyx's
model ask them).

Trade-off: the wording that reaches the transcript is now filtered
through _two_ models you don't control end-to-end — Telnyx's AI decides
how to ask, and (per the schema) how to normalize the answer into JSON
— for the free-narrative sections it's fine, but I'd keep it off the
`mortgage_status`/`coverage_determination`-style legal-wording variants
for the same reason Approach B exists: those need `<Gather>`'s exact
resolved branch, not an AI's paraphrase of one.

## Recommendation

**The hybrid described above** — plain `<Gather>` only for standalone
branches, bundled `<AIGather>` everywhere a branch has a natural
attached detail or a cluster of free-text facts belongs together, and
`<Record>` for pure narrative. It's what `template/interactive-call-script.txt`
is written to, section by section — that file is the canonical mapping
of field → verb → exact prompt wording; this doc is the reasoning
behind it, not a second source of truth to keep in sync by hand.

This keeps every branch/variant decision exact and deterministic where
it matters (matches the README's "don't let a model reword the legal
wording" rule), keeps `webhook.js`/`matcher.js`/`openrouter.js` doing
what they already do for narration, and avoids the two failure modes
of the simpler alternatives: plain chained `<Record>` (Approach A)
leaves every branch decision as an LLM guess after the fact — the
exact risk Phase 1 of the template rework was written to reduce — and
a strict one-Gather-per-field version of Approach B turns every
mortgage/coverage/exterior/personal-property/mitigation question into
two robotic round-trips instead of the one natural exchange an
adjuster would actually give.

## Topic drift and cross-section reconciliation

None of the per-turn verbs route content to the right section on their
own. Each turn's webhook response is scoped to capture _one_ section's
fields — true for `<Record>`, `<Gather>`, and a per-section `<AIGather>`
alike. If the adjuster is mid-`<Record>` on `coverage_cause_narrative`
and starts describing roof damage, that audio still gets transcribed
and attached to `coverage_cause_narrative` — `<Record>` has no content
awareness, it just captures until silence/timeout. A per-section
`<AIGather>` behaves best of the three (schema-scoped, so a model-driven
turn likely stays on topic) but still has no schema slot to write a
roof comment into while nominally collecting coverage fields.

Fix: **sections stay a prompting/UX and completeness-check boundary,
not a data boundary.** Stitch every section's transcript back into one
full transcript, labeled by section, in call order, and run a single
extraction pass over the whole thing at the end — same shape as
today's one-shot flow, just with section labels as extra context
instead of one undifferentiated blob. A stray roof comment recorded
during the coverage section still lands in the combined transcript;
the extraction prompt can place it in `roof_damage_narrative` the same
way it already routes out-of-place claim numbers/dates to
`unplaced_notes` today (Phase 1d rework in `prompt.js`). This keeps
every branch/completeness benefit of the section-by-section call while
recovering the order-independence adjusters already get from narrating
freely in one shot.

The alternative — genuine mid-call redirect ("let's finish coverage,
I'll get to the roof") — needs the model to have the _whole_ schema in
view in one conversation, not just the current section's slice: one
call-spanning `<AIGather>` or the standalone Conversational AI
Assistant, in exchange for giving up the deterministic per-field
`<Gather>` branch control Approach B was built to protect. Not worth
reaching for unless end-of-call reconciliation proves insufficient in
practice.

## Answering "if it's not possible on TeXML, what's the other setup"

It's fully possible on TeXML — Approaches A/B/C above are all standard
TeXML verbs, no product outside TeXML required. Your 99% was right.

The one thing genuinely _outside_ TeXML is Telnyx's standalone
**Conversational AI / Voice Assistant** product: a persistent AI
Assistant object configured once (via the Telnyx portal or a separate
API, not an XML file you check into this repo) and either attached
directly to a phone number or dialed into mid-call from TeXML via
`<Dial><AI assistant_id="..."/></Dial>`. It runs one continuous
open-ended conversation for the whole call rather than a sequence of
discrete per-section turns, using function-calling "tools" to hit your
webhook. It's a heavier setup — the assistant's config lives outside
this repo's git history, in Telnyx's dashboard/API — and it's the same
"AI paraphrases the answer" trade-off as Approach C but for the _entire_
call, including the legal-wording variant fields B is specifically
designed to protect. I don't think this use case needs it: Approach B
gets the interactivity the script calls for while keeping the parts of
the Ibis template that must render exact wording under your own code's
control, not a hosted assistant's.
[[Conversational AI overview](https://developers.telnyx.com/docs/voice/conversational-ai/quickstart)]

## Sources

- [TeXML application setup](https://developers.telnyx.com/docs/voice/programmable-voice/texml-setup)
- [TeXML verbs index](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs)
- [`<Gather>` verb reference](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/gather)
- [`<AIGather>` verb reference](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/aigather)
- [Using AI with Gather — guide](https://developers.telnyx.com/docs/voice/programmable-voice/gather-using-ai/index)
- [`<Redirect>` verb reference](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/redirect)
- [Voice docs overview](https://developers.telnyx.com/docs/voice/overview)
- [Conversational AI overview](https://developers.telnyx.com/docs/voice/conversational-ai/quickstart)
