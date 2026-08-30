# Dograh workflow — local mirror

Local mirror of the Dograh-hosted voice workflow **"Note Taker - inbound"**
(workflow id `10551`), pulled via the `dograh` MCP server
(`get_workflow_code`). This is not read by any pipeline code — it exists so
the actual live agent config is diffable in git instead of only living on
Dograh's platform.

**There is no automatic sync in either direction.** Nothing watches Dograh
for a publish/edit and nothing here pushes on save. This file is only ever
as current as its last manual pull — see the publish log below for when
that last happened and what the state was at that time. `get_workflow`
(not `get_workflow_code`) returns a `version` field of `"draft"` or
`"published"` for whatever is currently live/being edited — that's the
only way to check current state, and it has to be checked on demand, by
asking Claude to re-pull or by checking in Dograh's UI directly.

**Whenever the workflow changes on either side** — someone edits directly
in Dograh, someone here pushes via `save_workflow`, or someone publishes a
draft — re-pull with `get_workflow_code`/`get_workflow`, update this file
and `dograh-script.md` (see below) to match, and add a line to the publish
log.

## Publish log

| Date       | Event                            | Version          | Notes                                                                                                                                                                                                                                       |
| ---------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-22 | Synced draft via `save_workflow` | draft v4         | Brought the draft in line with `enums.json`'s XM8/origin-split changes. Published v3 (pre-sync schema) was still live for real calls at this point.                                                                                         |
| 2026-08-22 | Verified via `get_workflow`      | **published v4** | v4 (the synced version above) is now published and live for real calls — published by someone outside this session, not via any tool available here. This file's "Node graph"/node sections below reflect v4's content, now confirmed live. |

## Node graph

```
start_call ──(caller understood + ready to work the claim)──▶ main_agenda_and_questions ──(issue fully handled)──▶ end_call
    │
    └──(wrong number / spam / caller wants to stop)──▶ end_call

main_agenda_and_questions ──(extraction_enabled, on call end)──▶ notetaker_export (webhook)
```

`notetaker_export` isn't wired as a graph edge — it fires from
`main_agenda_and_questions`'s extraction results at call end, POSTing to
`apps/bh-systems`'s TeXML proxy (`event=dograh_notetaker`), which forwards
into `apps/adjuster/src/webhook.js`'s `handleDograhNotetaker()`.

## Node: `start_call`

The opening greeting/turn. Establishes who's calling and what they need
before handing off to the main node. Unchanged by this session's edits.

```
prompt:
# MAIN ACTION POINT AT THIS STAGE

You have received an inbound call from a user.
Greet the user, tell them your name and company name if available, ask for their name, and ask how you can help them today.

Do all of this in a single natural opening statement with no breaks, fillers, or change of turn.
If company name is not given, do not say company name.

## Call flow
Stay in this node for the opening part of the conversation.
Do not move to Main Agenda immediately after the first user reply.
Use the first 1 to 3 user turns to understand who is calling and what they need.
If needed, ask a short clarifying question here so that the issue is clear enough to hand off.

Move to Main Agenda only when:
- you know what the caller needs help with
- you have enough context to start handling the actual task

If it is a wrong number, wrong company, spam, or the caller does not want to continue, choose End Call.

## Critical rules
- If the last message is not a user message, do not make a tool call.
- Never mix text and tool calls in the same output.
- Your turn must end with either a question or a tool call, never both together.
```

## Node: `main_agenda_and_questions`

The working node — asks every question, tracks every variable, and runs
Dograh's own live structured-data extraction at call end (independent of
and in addition to the offline `prompt.js`/OpenRouter extraction pass that
runs later over the full transcript).

### `prompt` (conversational instructions)

**Kept in sync verbatim with [`dograh-script.md`](./dograh-script.md)** —
that file _is_ this field's content; edit it there, not here, then re-sync
this snapshot after pushing to Dograh.

### `extraction_prompt` (Dograh's own structured-extraction system prompt)

```
You are extracting structured fields from a public adjuster's spoken claim intake call. Your output pre-fills a report draft the adjuster reviews before filing: a field you leave empty costs a few seconds of review, a field you guess wrong can end up in a filed insurance report.
Extract only what the caller actually said. Never fill a field from inference, typical values, or outside knowledge. When the caller did not state a field, leave it empty rather than guessing.
For any field whose hint below lists allowed values, the value must exactly match one of those values, character for character. Choose the closest matching allowed value only when the call clearly supports it; if nothing said reasonably maps to an allowed value, leave the field empty instead of forcing a bad fit.
Status fields (mortgage_status, roof_status, exterior_status, personal_property_status, mitigation_status) require an affirmative statement before you set a value — silence about a section is not evidence of 'none' or 'not_affected'.
Narrative fields should be written as report prose in first-person-plural voice ('We observed...', 'We will estimate to repair...'), using only facts the caller actually stated.
origin_narrative is the cause of loss only; origin_damage_narrative is what was actually damaged as a result — do not restate the cause in the damage field or vice versa.
Dates (date received, date contacted, date inspected, date of loss), the mortgage lender name, claim numbers, and carrier names are handled outside this extraction — do not try to capture them here.
```

### `extraction_variables` (Dograh's structured-output schema)

This is the field list Dograh actually returns as structured data — separate
from (and a subset of the intent of) `enums.json`'s schema. Field names
match `enums.json`'s tags 1:1 where both exist; `mortgage_company` was
removed here (matching `enums.json`) since `[XM8_MORTGAGEE1]` fills the
lender name outside this pipeline, and `origin_damage_narrative` was added
alongside `origin_narrative` (matching `enums.json`'s cause/damage split).

| name                          | type   | prompt                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contacted_party_name`        | string | Name of the person the adjuster contacted to set up the inspection. Required.                                                                                                                                                                                                                      |
| `present_at_inspection`       | string | Full sentence naming who was present during the inspection and ending in 'present during the inspection.' (e.g. 'Jane Smith was present during the inspection.', 'Jane Smith and John Doe were present during the inspection.'), with was/were conjugated correctly for the count named. Required. |
| `mortgage_status`             | string | Whether there is a mortgage on the property. Required. Allowed values: has_mortgage, no_mortgage. Only set from an affirmative statement, not silence.                                                                                                                                             |
| `origin_narrative`            | string | The cause-of-loss story as report prose: what happened, when, how the damage spread, and any official determination — the cause only, not what was damaged as a result (that's origin_damage_narrative). Required.                                                                                 |
| `origin_damage_narrative`     | string | What was actually damaged as a result of the cause described in origin_narrative — the specific items, rooms, or areas affected, as report prose. Do not restate the cause here, only the resulting damage. Required.                                                                              |
| `coverage_cause_narrative`    | string | Short clause describing why the damage is or is not covered, e.g. 'storm related', 'related to a burst plumbing line due to freezing'. Required.                                                                                                                                                   |
| `coverage_determination`      | string | Coverage determination. Required. Allowed values: covered, excluded.                                                                                                                                                                                                                               |
| `coverage_supporting_detail`  | string | Optional supporting detail for the coverage determination, e.g. confirming heat was maintained for a freeze claim. Leave empty if nothing extra was said.                                                                                                                                          |
| `dwelling_type`               | string | Dwelling type. Required. Ex: single family, duplex, multi family.                                                                                                                                                                                                                                  |
| `dwelling_stories`            | string | Number of stories, as the adjuster actually said it. Required. Ex: 1 story, 2 story, 3 story — but use whatever he says (a story and a half, split level, etc.) rather than forcing it into one of those.                                                                                          |
| `year_built`                  | string | Year the dwelling was built. Required — flagged for manual input if not stated and not on the calendar invite.                                                                                                                                                                                     |
| `foundation_type`             | string | Foundation type. Required. Ex: crawlspace, basement, slab.                                                                                                                                                                                                                                         |
| `siding_type`                 | string | Siding type. Required. Ex: vinyl siding, stucco siding, a brick veneer, steel siding, aluminum siding, wood siding, fiber board siding, vertical wood siding, cedar wood siding, hardiplank siding, fiber cement siding.                                                                           |
| `square_footage`              | number | Interior square footage, digits only (e.g. '2150'). Required.                                                                                                                                                                                                                                      |
| `bedroom_count`               | number | Number of bedrooms. Required.                                                                                                                                                                                                                                                                      |
| `bathroom_count`              | string | Number of bathrooms. Required.                                                                                                                                                                                                                                                                     |
| `occupancy_status`            | string | Who currently occupies the dwelling. Required. Ex: the insured, a tenant, tenants.                                                                                                                                                                                                                 |
| `roof_status`                 | string | Whether the roof was affected. Required. Allowed values: not_affected, shingle, other_material. Only set from an affirmative statement, not silence.                                                                                                                                               |
| `roof_covering_type`          | string | Shingle covering type. Required only when roof_status is shingle. Ex: 20 year 3 tab shingles, 25 year 3 tab shingles, 30 year laminate shingles, 40 year laminate shingles, 50 year laminate shingles, Wood shingles, Cedar shakes.                                                                |
| `roof_condition`              | string | Shingle condition for its age. Required only when roof_status is shingle. Ex: average, below average.                                                                                                                                                                                              |
| `roof_age_years`              | string | Roof age in years, digits only (e.g. '12'), not an install year. Required only when roof_status is shingle.                                                                                                                                                                                        |
| `roof_pitch`                  | string | Roof pitch. Required only when roof_status is shingle. Typically: 1/12, 2/12, 3/12, 4/12, 5/12, 6/12, 7/12, 8/12, 9/12, 10/12, 12/12, greater than 12/12.                                                                                                                                          |
| `roof_damage_narrative`       | string | Per-slope roof findings, including slopes with no damage, ending with a repair-or-replace conclusion. Required only when roof_status is shingle.                                                                                                                                                   |
| `roof_narrative_freeform`     | string | Full roof narrative for a non-shingle roof: material, age, condition, layers, pitch, per-slope findings, conclusion. Required only when roof_status is other_material.                                                                                                                             |
| `exterior_status`             | string | Whether the exterior was affected. Required. Allowed values: not_affected, affected.                                                                                                                                                                                                               |
| `exterior_narrative`          | string | Elevation-by-elevation exterior findings (Front, Right, Back, Left), including undamaged elevations. Required only when exterior_status is affected.                                                                                                                                               |
| `interior_damage_narrative`   | string | Interior damage findings, grouped by level if the property is multi-level. Optional — leave empty if nothing was said.                                                                                                                                                                             |
| `personal_property_status`    | string | Personal property status. Required. Allowed values: none, damaged.                                                                                                                                                                                                                                 |
| `personal_property_narrative` | string | Personal property damage findings. Required only when personal_property_status is damaged. Leave empty rather than guessing at unlisted items.                                                                                                                                                     |
| `mitigation_status`           | string | Whether a mitigation vendor was involved. Required. Allowed values: none, present.                                                                                                                                                                                                                 |
| `mitigation_narrative`        | string | Who responded, what emergency work was performed, and what is still running or pending. Required only when mitigation_status is present.                                                                                                                                                           |
| `overhead_profit_narrative`   | string | Overhead and profit determination with a claim-specific reason. Required.                                                                                                                                                                                                                          |
| `subrogation_reason`          | string | Subrogation reason clause completing 'There are no subrogation possibilities as the damages are \_\_\_', e.g. 'weather related'. Required.                                                                                                                                                         |
| `coinsurance_status`          | string | Coinsurance status. Required. Allowed values: no_coinsurance, applies. Set to no_coinsurance when the adjuster explicitly says no penalty applies (renders a canned "no coinsurance" line) — the normal case for almost every claim. Only set to applies when real figures/penalty are stated.     |
| `coinsurance_narrative`       | string | Coinsurance figures/penalty details. Required only when coinsurance_status is applies.                                                                                                                                                                                                             |

`allow_interrupt: false`, `extraction_enabled: true`.

## Node: `global_node`

Persona and cross-cutting behavior (ASR-handling, tone, turn-taking). Not
touched by this session's edits — no Ibis/XM8/field-schema content lives
here, so nothing needed to change.

```
prompt:
# OVERALL GOAL

You are Sam. We are getting inbound calls for **gathering information from public adjusters for report completion**. Your goal is to address their queries or requests that fall within the following use cases: **collecting inspection details, confirming mortgage status, understanding damage coverage, recording dwelling inspection results, and clarifying terminology or technical jargon**. If the caller is hesitant, confused, or does not want to continue, keep the interaction brief, answer only what is easy to answer, and politely end the call. Keep responses short, 2–3 sentences- max 25 words.

## Response Language
You are a Voice AI Agent who can speak in multiple languages. Your output is played over TTS, so dont generate special characters. Use very simple and conversational language.

---

## HANDLING ASR / TRANSCRIPTION ISSUES

You are speaking on a phone call with a human user. The audio can be noisy and ASR (speech-to-text) can be imperfect. Follow all instructions below carefully.

1. **When the text looks strange or unclear**

   - If the user's message looks weird, unexpected, or unclear:
     - If you can **guess** what they meant and it does **not** affect your next action, just respond normally.
     - Only ask for clarification if the information:
       - Is important for your next step, or
       - Needs to be saved or is critical to the task.

2. **How to ask for clarification**

   - Be casual and polite.
   - Use phrases like:
     - "sorry, did not catch that."
     - "hey sorry, some noise there - could you repeat?"
     - "hold on, you are coming choppy."
   - Do **not** mention transcription / ASR errors.
   - Do **not** repeat the same clarification phrase again and again.

3. **If it seems off but not important**

   - If what they said seems odd but does not matter for your next steps, just continue without asking.

4. **Never use their name**
   - Do not say the user's name at all, because it may be misheard or mispronounced.

---

## SUMMARY OF KEY BEHAVIOR
- Keep responses short, 2–3 sentences. 10 - 25 words total
- Speak in informal, relaxed tone
- Always listen and wait after questions or suggestions.
- Handle ASR noise gracefully; clarify only when needed.
- Acknowledge objections, answer using given info, and then resume where you left off.
- Avoid repetition by always checking your last turn.
- Use tool calls with **only** the function syntax and no extra text.

---
```

## Node: `end_call`

```
prompt:
# Main Action Point for This Stage

At this stage, the conversation with the user is complete. They have no further questions. Your job is to end the call politely and immediately. Do **not** start any new topics. Even if there are unresolved threads, you must ignore them and proceed to close the conversation. Do **not** wait for the user, do **not** ask questions, and do **not** hand the turn back to them.

**Generate a brief response (6–8 words)** that naturally follows from the user's last message. Example: "Thank you for the call. And have - a wonderful day"

After this, say nothing else. The call is over.
```

`extraction_prompt: ""`, `extraction_variables: []`.

## Webhook: `notetaker_export`

Fires at call end with `main_agenda_and_questions`'s extraction results,
POSTing to `endpoint_url: https://www.bh-systems.com/texml/gas?t=<redacted>&event=dograh_notetaker`
(secret redacted here; see the live config or `apps/bh-systems` for the real
value — never commit the real token).

`payload_template` maps every `extraction_variables` field through
`{{gathered_context.<name>}}`, plus call metadata
(`capture_id`, `call_disposition`, `duration_sec`, `call_time`,
`recording_url`, `transcript_url`). `mortgage_company` was removed and
`origin_damage_narrative` added to match `extraction_variables` above —
this mapping must always be a superset of what `extraction_variables`
defines, or a field silently never reaches
`apps/adjuster/src/webhook.js`'s `handleDograhNotetaker()` even after
Dograh extracts it.

## Known gaps carried over from this sync

- **`year_built`/`square_footage`/`bedroom_count`/`bathroom_count`** are
  still valid `extraction_variables` (opportunistic capture if the caller
  volunteers them) even though the `prompt` no longer asks for them — see
  `apps/adjuster/template/README.md`'s "Phase 4" entry. No calendar/claim
  data pipeline exists yet to actually fill these from outside the call.
- **`[XM8_MORTGAGEE1]`/`[XM8_INSURED_NAME]`** are Ibis template merge
  tokens, not something this workflow needs to know about — intentionally
  absent from every prompt/extraction field here, same reasoning as the
  `[DATE_*]` tokens already being invisible to this workflow.
