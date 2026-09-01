# Adjuster MVP — Voice Capture to Draft Report

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-08-15

> **Telnyx sections superseded (spec-019, 2026-09-01).** This spec's
> call-capture path was Telnyx (a phone number + TeXML). Telnyx has since
> been retired — see [ADR 008](../adr/008-telnyx-retired.md) — and Retell
> and Dograh are the supported voice platforms. The Telnyx-specific sections
> below are left in place as history and marked superseded inline; the rest
> of this spec (matcher, extraction, the trust boundary, the doc generator,
> acceptance criteria) still describes the pipeline Retell and Dograh feed
> into today.

## Objective

A phone call placed from a moving truck produces a draft inspection report as a
Google Doc in a Drive folder, with no manual step afterward. Brandon (an
independent insurance adjuster) inspects a property, drives away, dials a saved
contact, talks for 5 to 15 minutes, and finds a populated draft waiting when he
gets home. Every value in that draft is traceable to something he actually said;
everything else renders as a visible `[NEEDS INPUT: …]` marker. The MVP exists to
answer one question: does he edit the draft, or rewrite it?

## Non-goals

Explicitly out of scope. Say no to these on purpose.

- More than one vendor template. Build the single-template path only.
- Water claims and their 2 to 6 iteration sequence.
- Photo capture, upload, or embedding.
- Xactimate integration of any kind, including line-item mining from the sample PDF.
- Scheduling and routing.
- The section-by-section AI interview (prompted dictation).
- A mobile app, an iOS build, or any capture path that lives on a device.
- Multi-user support, billing, auth, or a UI. There is no front end in this MVP.
- Real-time transcription or live prompting during the call.

## Business rationale

Brandon writes 12 to 15 reports a week at 20 to 30 minutes each by hand, so 2 to
6 hours weekly. If a draft takes him 10 minutes to finish instead, most of that
value is captured. Running cost at this volume is roughly $10/month in telephony
and transcription plus about $5/month in model calls. The constraint is build
time, not spend.

## Context: decisions already settled

These are recorded so the spec does not get relitigated mid-build.

**Device apps are out, the call path is in.** Cube ACR's iOS build requires a
three-way merge mid-call (iOS blocks third-party apps from tapping call audio
directly), so it is not hands-free, and it is redundant when the telephony vendor
already records. More importantly: Barton is on Android, Brandon is on iPhone.
Any capture method living in a phone app has to be validated on the device it
will run on, and an Android test proves nothing about an iPhone. A phone call
behaves identically on both. Every hour of local testing is real signal.

**Telnyx first, Twilio as fallback.** _Superseded (spec-019) — Telnyx is
retired; see [ADR 008](../adr/008-telnyx-retired.md)._ Telnyx TeXML
`<Record>` records, transcribes via Deepgram, and POSTs the finished text in
one step. Twilio's built-in transcription is capped at two minutes,
English-only, and deprecated, which forces a fetch-and-transcribe pattern.
That pattern is the documented fallback here and works on either vendor, so
switching costs one component, not a rebuild.

**Runtime is Google Apps Script.** Chosen deliberately over this repo's
TypeScript/Supabase stack: the deliverable is a Google Doc in a Google Drive
folder built from a Google Doc template, and Apps Script reaches
DocumentApp/DriveApp/CalendarApp with no OAuth plumbing, no service account, and
no deploy pipeline. Pure logic still gets unit tests (see
[Repo layout and testing](#repo-layout-and-testing)). This deviates from
`.claude/CLAUDE.md` and warrants an ADR.

**All model calls go through OpenRouter.** A claude.ai Pro/Max subscription
cannot be called from a server, and the Anthropic API is billed separately from
it, so the unattended extraction call needs a paid key regardless. OpenRouter
puts 300+ models behind one OpenAI-compatible Chat Completions endpoint, so
switching between Claude, GPT, Gemini, or anything cheaper is a script-property
change with no code touched. This matches the direction already set in
[010-openrouter-ai-client.md](010-openrouter-ai-client.md). One vendor, one key,
one code path. The subscription still earns its keep in stage 3, where prompt
iteration is local and can run through Claude Code before a production model is
pinned.

---

## Architecture

### Data flow

```
Brandon's iPhone
      │  dials saved contact "Field Notes"
      ▼
Telnyx number ──► TeXML Application ──► static TeXML (Cloudflare Pages)
      │                                  <Say> beep <Record transcription="true">
      │
      ├─ recordingStatusCallback ──┐
      └─ transcriptionCallback ────┤
                                   ▼
                    Apps Script Web App  doPost(?t=SECRET&event=…)
                                   │  upsert row by capture_id
                                   │  fetch mp3 to Drive IMMEDIATELY (10-min URL expiry)
                                   ▼
                            Jobs sheet (status: awaiting_transcript → pending)
                                   │
                    1-minute time trigger picks oldest pending
                                   ▼
              claim matcher ──► extractor (LLM) ──► validator ──► doc generator
                                   │                                    │
                            Claims sheet                         /Adjuster/Drafts/
                         (calendar-derived)                       + email notify
```

### Google account ownership

Everything is built in **Barton's Google account** and migrated to Brandon's
after stage 4 passes. Consequences the build must respect:

- The Drafts folder is shared to Brandon with edit access from day one, so he
  never has to wait on a migration to see output.
- Calendar access is **not** assumed. The matcher reads a `Claims` sheet, never
  CalendarApp directly. A separate, replaceable `syncClaimsFromCalendar()`
  function fills that sheet once read access exists. Until then the sheet is
  filled from a CSV export of a week of Brandon's calendar. The matcher's input
  contract does not change when access arrives.
- Migration path at the end: transfer ownership of the Drive folder, the Jobs
  spreadsheet, and the Apps Script project, then re-authorize triggers under his
  account. Budget an hour and treat re-authorization as the risky step.
- Apps Script quotas differ between consumer Gmail and Workspace (trigger runtime
  and UrlFetchApp calls/day). Confirm Brandon's account type before migration and
  re-check headroom then, since a 1-minute trigger burns 1,440 executions/day.

### Telephony: TeXML contract

> **Superseded (spec-019).** This entire section describes the Telnyx TeXML
> `<Record>` contract, which no longer exists in the codebase — see
> [ADR 008](../adr/008-telnyx-retired.md). Left in place as history.

Verified against Telnyx TeXML `<Record>` docs on 2026-08-15. Attribute names
below are exact; the earlier draft's `transcribe` is Twilio's spelling and does
not apply.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Field notes. Start after the beep. Hang up when you are done.</Say>
  <Record
    action="https://script.google.com/macros/s/DEPLOY_ID/exec?t=SECRET&amp;event=action"
    method="POST"
    maxLength="900"
    timeout="0"
    playBeep="true"
    format="mp3"
    channels="single"
    finishOnKey="#"
    recordingStatusCallback="https://script.google.com/macros/s/DEPLOY_ID/exec?t=SECRET&amp;event=recording"
    recordingStatusCallbackEvent="completed"
    recordingStatusCallbackMethod="POST"
    transcription="true"
    transcriptionEngine="deepgram"
    transcriptionModel="deepgram/nova-3"
    transcriptionLanguage="en-US"
    transcriptionCallback="https://script.google.com/macros/s/DEPLOY_ID/exec?t=SECRET&amp;event=transcription" />
</Response>
```

Attribute choices with reasons:

| Attribute     | Value    | Why                                                                                                                                               |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxLength`   | `900`    | 15 minutes. Allowed range is 0 to 14400, default 3600.                                                                                            |
| `timeout`     | `0`      | Infinite silence tolerance. Any positive value ends the recording during a thinking pause, which is exactly what happens when someone is driving. |
| `finishOnKey` | `#`      | Default is every digit plus `*` and `#`. A stray DTMF from a pocketed phone would truncate the recording.                                         |
| `channels`    | `single` | One leg, one speaker. Halves file size for the Drive copy.                                                                                        |
| `format`      | `mp3`    | Smaller than wav for the Drive copy and accepted by Deepgram on the fallback path.                                                                |

**Hosting the TeXML:** serve it as a static XML file from the existing Cloudflare
Pages deployment (`/texml/field-notes.xml`), not from Apps Script. Apps Script web
apps answer with a 302 to `script.googleusercontent.com`, and a redirect in the
call-answering path is an avoidable failure mode. The XML never changes, so a
static asset is the right shape. Callback URLs still point at Apps Script, where
a redirect is harmless because the side effect completes during the POST.

**Webhook authenticity:** Telnyx signs webhooks with Ed25519, which Apps Script
cannot verify (Utilities offers HMAC-SHA256 and digests, no Ed25519). MVP auth is
therefore a shared secret in the query string (`?t=SECRET`, stored in Script
Properties) plus a payload sanity check: reject any callback whose
`call_session_id` does not look like a Telnyx UUID, and reject `from` numbers not
on a small allowlist. This is documented as a known weakness, acceptable because
the worst case is a junk row in a private sheet.

**Delivery is at-least-once.** Because of the 302, Telnyx may treat a delivered
callback as failed and retry. Every handler **upserts by `capture_id`**
(`call_session_id`), never appends. Two callbacks for the same call write to the
same row.

**The 10-minute expiry is load-bearing.** Telnyx recording URLs are valid for 10
minutes after the call ends. The `recording` handler must copy the mp3 into
`/Adjuster/Recordings/` with UrlFetchApp during the POST itself. Deferring this to
the 1-minute trigger risks losing the audio, which kills the Deepgram fallback and
any chance of re-transcribing a bad call.

### Jobs sheet schema

One spreadsheet, tab `Jobs`. Row 1 is the header; the code resolves columns by
header name, not index, so columns can be reordered safely.

| Column              | Type     | Notes                                                                                                                                          |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_id`        | string   | Telnyx `call_session_id`. Primary key, upsert key.                                                                                             |
| `created_at`        | ISO 8601 | First callback received.                                                                                                                       |
| `updated_at`        | ISO 8601 | Any write.                                                                                                                                     |
| `from_number`       | string   | E.164. Used for the caller allowlist.                                                                                                          |
| `call_started_at`   | ISO 8601 | Primary key for claim matching.                                                                                                                |
| `call_ended_at`     | ISO 8601 |                                                                                                                                                |
| `duration_sec`      | number   |                                                                                                                                                |
| `recording_url`     | string   | Originally a Telnyx URL (spec-019: Telnyx retired). Dograh and Retell also populate it, alongside `audio_drive_id`, which is the durable copy. |
| `audio_drive_id`    | string   | Drive file ID of the copied mp3.                                                                                                               |
| `transcript`        | string   | Full text. Truncated at 45,000 chars (cell limit is 50k).                                                                                      |
| `transcript_source` | enum     | `telnyx-deepgram-nova-3` \| `deepgram-direct` \| `manual`                                                                                      |
| `transcript_chars`  | number   | Cheap truncation detector against `duration_sec`.                                                                                              |
| `status`            | enum     | See below.                                                                                                                                     |
| `attempts`          | number   | Incremented per runner pickup. Max 3.                                                                                                          |
| `lease_until`       | ISO 8601 | Stuck-job recovery.                                                                                                                            |
| `claim_id`          | string   | Key into the Claims sheet. Blank when unmatched.                                                                                               |
| `match_method`      | enum     | `calendar-exact` \| `calendar-nearest` \| `ambiguous` \| `none`                                                                                |
| `match_confidence`  | enum     | `high` \| `low` \| `none`                                                                                                                      |
| `doc_url`           | string   | Generated draft.                                                                                                                               |
| `needs_input_count` | number   | Quality metric over time.                                                                                                                      |
| `model`             | string   | OpenRouter model ID that actually produced the draft, after any fallback.                                                                      |
| `error`             | string   | Last error message.                                                                                                                            |

Status values: `awaiting_transcript` → `pending` → `matching` → `extracting` →
`generating` → `done`. Terminal off-ramps: `failed`, `needs_review` (draft exists
but the match is contested).

A job becomes `pending` when both the recording and transcription callbacks have
landed. If the recording callback arrives and no transcript follows within 15
minutes, the runner promotes the row to `pending` with
`transcript_source = deepgram-direct` and transcribes from the Drive audio.

### Claims sheet schema

Tab `Claims`. Filled from a calendar CSV export now, from `syncClaimsFromCalendar()`
later. The matcher only ever reads this shape.

| Column                    | Notes                                                   |
| ------------------------- | ------------------------------------------------------- |
| `claim_id`                | Stable key. Calendar event ID when synced, else a slug. |
| `appt_start` / `appt_end` | ISO 8601.                                               |
| `insured_last_name`       |                                                         |
| `address_line1`           |                                                         |
| `city`                    |                                                         |
| `claim_number`            | Optional.                                               |
| `carrier`                 |                                                         |
| `loss_type`               | Must match the enum file.                               |
| `vendor`                  | Single value for the MVP.                               |

### Claim matcher

Timestamp is the identifier. The spoken address or name is a confirmation check,
never the key. Disagreement is flagged, not guessed.

1. Candidate window: appointments whose `appt_end` falls in
   `[call_started_at - 4h, call_started_at + 30m]`.
2. Rank by proximity of `appt_end` to `call_started_at`, preferring appointments
   that ended before the call.
3. Confirmation: normalize the first 600 characters of the transcript and look
   for the candidate's `insured_last_name`, street number, or street name.
   Normalization lowercases, strips punctuation, and expands common street
   abbreviations.
4. Outcomes:
   - Exactly one candidate and confirmation hits → `calendar-exact`, `high`.
   - Exactly one candidate, no confirmation hit → `calendar-nearest`, `low`.
   - Two or more candidates within 45 minutes of each other → `ambiguous`, `low`,
     status `needs_review`. The draft is still generated against the top
     candidate, with both candidates named in the header banner.
   - No candidates (no calendar yet, or a call from nowhere) → `none`, `none`.
     The draft is generated with claim fields left as `[NEEDS INPUT]`.

The matcher is a pure function: `matchClaim(callStartedAt, transcript, claims)
→ {claim_id, match_method, match_confidence, candidates[]}`. It is the most
heavily unit-tested piece in the build.

### Extraction: OpenRouter client

One client, one endpoint, model chosen by script property so a swap is a config
change and never a deploy:

```
extractFields({transcript, claim, templateSpec, enums, glossary, phraseBank})
  → {fields: {[tag]: {value, source_span, confidence, enum_value?}},
     unplaced_notes: string[],
     model: string,
     usage: {input_tokens, output_tokens}}
```

- `llm/openrouter.js`: a hand-rolled UrlFetchApp wrapper of roughly 50 lines
  against `POST https://openrouter.ai/api/v1/chat/completions`. No maintained
  client library exists for Apps Script, and none is needed for one endpoint.
- **Chat Completions only.** OpenRouter does not support the OpenAI Responses
  API. Structured output comes from `response_format: {type: 'json_schema'}`
  with the schema generated from `enums.json`.
- Model IDs are `org/model-name`, for example `anthropic/claude-opus-4-7` or
  `openai/gpt-5.4`. Set in `OPENROUTER_MODEL`.
- **Fallback chain** via the `models` array in the request body. OpenRouter tries
  each in order on 5xx or rate-limit. Set in `OPENROUTER_FALLBACKS` as a
  comma-separated list. Because a fallback can silently change which model wrote
  a report, the model actually used comes back in the response body and is
  written to the Jobs row and the draft header. A draft never fails to say what
  produced it.
- Not every model on OpenRouter honors `json_schema`. Pin the primary and every
  fallback to models that do, and treat a malformed response as a hard failure
  rather than parsing loosely: the validator downstream assumes well-formed
  fields.
- `muteHttpExceptions: true`, retry on 429 and 5xx twice with 5s then 15s backoff
  via `Utilities.sleep`. Total retry budget stays well inside the 6-minute cap.
- `unplaced_notes` catches anything Brandon said that no tag covers. It goes into
  a "Not placed" section at the end of the draft rather than being discarded,
  because on the first few reports it is the fastest signal about which tags the
  template is missing.

**Trade jargon repair happens in the prompt, not the transcript.** Telnyx TeXML
exposes engine and model but no keyterm parameter, so Deepgram's nova-3 `keyterm`
boosting is only available on the fallback direct-Deepgram path. The 60-term
trade glossary is therefore built once and used two ways: as a `glossary` block
in the extraction prompt on the Telnyx path, and as `keyterm` parameters on the
fallback path. The transcript does not need to be right, only close enough to
disambiguate given the template, the loss type, and the glossary.

### The trust boundary

This rule is what makes the output worth reading, and it is enforced in code, not
in the prompt.

> No number, measurement, material, or age appears in the draft unless it is
> traceable to something Brandon actually said.

The validator runs after the model returns and before the doc is generated. A
field is emitted only if **all** of these hold:

1. `source_span` is a non-empty string.
2. `source_span` is an **exact substring of the transcript**, checked with
   whitespace-normalized comparison. Not fuzzy, not semantic.
3. For enum-typed tags, `value` is a member of that tag's enum list.
4. `confidence` is not `low`.

Any field failing any check renders as `[NEEDS INPUT: <human label>]`, highlighted
in the doc. The generator refuses to emit a field without a passing `source_span`.
A draft that is 80% done with honest holes beats one that is 100% done and 3%
wrong, because the second forces re-verification of every line, which is the job
he was trying to skip. The `needs_input_count` per report is a free quality
metric to watch over time.

### Template and enum contract

Two artifacts, produced by hand in phase 0 and treated as the schema for
everything downstream.

- **`template.gdoc`**: Brandon's blank vendor template, flattened into a Google
  Doc, with every blank and bracket replaced by a `{{snake_case_tag}}`. Word
  content controls do not survive import to Google Docs, so this conversion is
  mandatory. Tags appear exactly once each.
- **`enums.json`**: every dropdown's option list, plus per-tag metadata:

```json
{
  "roof_covering_type": {
    "label": "Roof covering type",
    "type": "enum",
    "values": [
      "3-tab asphalt shingle",
      "architectural shingle",
      "metal",
      "tile",
      "modified bitumen"
    ],
    "section": "Roof"
  },
  "roof_pitch": { "label": "Roof pitch", "type": "string", "section": "Roof" },
  "date_of_loss": { "label": "Date of loss", "type": "date", "section": "Claim" }
}
```

Every `{{tag}}` in the Doc must have an entry in `enums.json` and vice versa. A
`validateTemplate()` function asserts this and runs in CI-equivalent fashion via
the unit test suite, because a tag with no schema entry silently produces an
unreplaced `{{tag}}` in a report handed to a client.

### Doc generator

1. `DriveApp` copy of the template into `/Adjuster/Drafts/`, named
   `YYYY-MM-DD — <insured_last_name or "UNMATCHED"> — <address_line1>`.
2. Insert a header block at the top of the body: capture ID, call time and
   duration, match method and confidence, contested candidates when ambiguous,
   the model actually used, `needs_input_count`, and links to the transcript row and
   the Drive audio.
3. For each tag in `enums.json`: `body.replaceText('{{tag}}', …)` with the
   validated value, or with `[NEEDS INPUT: <label>]`.
4. Second pass: find every `[NEEDS INPUT:` occurrence and set a yellow background
   so the holes are visible while scrolling.
5. Append the "Not placed" section from `unplaced_notes` when non-empty.
6. Assert no `{{` remains in the body. If any does, set status `failed` with the
   offending tags in `error` rather than shipping a broken doc.
7. Email Brandon and Barton with the doc link and the `needs_input_count`.

### Configuration and secrets

All in Apps Script **Script Properties**. Nothing in the repo, nothing in a sheet.

| Key                                         | Purpose                                   |
| ------------------------------------------- | ----------------------------------------- |
| `WEBHOOK_SECRET`                            | Query-string token on all callback URLs.  |
| `ALLOWED_CALLERS`                           | Comma-separated E.164 allowlist.          |
| `JOBS_SHEET_ID`                             | Spreadsheet ID.                           |
| `TEMPLATE_DOC_ID`                           | Google Doc template.                      |
| `DRAFTS_FOLDER_ID` / `RECORDINGS_FOLDER_ID` | Drive targets.                            |
| `OPENROUTER_API_KEY`                        | The only model credential.                |
| `OPENROUTER_MODEL`                          | Primary model, `org/model-name` format.   |
| `OPENROUTER_FALLBACKS`                      | Comma-separated fallback chain. Optional. |
| `DEEPGRAM_API_KEY`                          | Fallback transcription path only.         |
| `NOTIFY_EMAILS`                             | Comma-separated notification recipients.  |

`.clasp.json` holds the script ID and is gitignored.

### Repo layout and testing

Source lives in this repo and is pushed with `clasp`. Apps Script has no module
system, so files declare plain top-level functions and depend on globals.

```
apps/adjuster/
  appsscript.json
  src/
    webhook.js      doPost entry, callback routing, upsert, audio copy
    runner.js       1-minute trigger, lease/lock, pipeline orchestration
    jobs.js         Jobs + Claims sheet IO
    matcher.js      pure: matchClaim()
    prompt.js       pure: buildPrompt()
    validate.js     pure: validateFields(), source-span checking
    docgen.js       DocumentApp/DriveApp
    llm/openrouter.js
    config.js       Script Properties accessors
  template/enums.json
  template/glossary.json
tests/unit/adjuster/
  loadGs.ts         node:vm loader that evaluates a src file into a sandbox
  matcher.test.ts
  validate.test.ts
  prompt.test.ts
  template.test.ts  enums.json ↔ {{tags}} parity
```

`loadGs.ts` is roughly 15 lines: read the file, evaluate it in a `node:vm`
context with stub globals, return the declared functions. That keeps production
files free of module syntax while giving the pure logic real vitest coverage, as
required by `.claude/CLAUDE.md`. Apps Script surface code (`webhook`, `runner`,
`docgen`) is covered by the stage 1 to 3 protocol rather than by unit tests.

---

## Implementation phases

Each phase is independently testable. Phases 1 to 3 produce a working capture
loop before any model is involved.

### Phase 0 — Template flattening (do this first)

The longest single task and the real bottleneck. Not code.

- Convert Brandon's blank vendor template to a Google Doc.
- Replace every blank and bracket with a `{{tag}}`.
- Lift every dropdown into `enums.json` with label, type, values, section.
- Draft `glossary.json`: about 60 trade terms from the 10 sample reports.
- Write `template.test.ts` for tag/schema parity.
- Effort: 2 to 3 hours, plus a revision after the first real draft.

### Phase 1 — Telnyx number and TeXML

> **Superseded (spec-019).** Telnyx is retired — see
> [ADR 008](../adr/008-telnyx-retired.md). This phase's number, TeXML
> Application, and static XML no longer exist.

- Buy the number, create the TeXML Application, point it at the static
  `/texml/field-notes.xml` on Cloudflare Pages.
- Deploy the Apps Script web app as "Anyone", record the deploy ID.
- Verify the answer, beep, and record flow by calling from Barton's Android.
- Effort: 1 hour.

### Phase 2 — Webhook and Jobs sheet

- `doPost` routes on `event`, checks `t` against `WEBHOOK_SECRET`, checks
  `from_number` against `ALLOWED_CALLERS`.
- Upsert by `capture_id`. Never append.
- On `event=recording`: fetch the mp3 and write it to `/Adjuster/Recordings/`
  immediately, inside the POST.
- On `event=transcription`: write the transcript, flip status to `pending` when
  the recording side has landed.
- Log every raw callback body to a `Raw` tab for the first two weeks. Debugging a
  webhook you did not record is guesswork.
- Effort: 1.5 hours.

### Phase 3 — Runner and lease

- 1-minute time trigger. `LockService` guard against overlapping executions.
- Pick the oldest `pending` row, set `lease_until = now + 10m`, increment
  `attempts`.
- Reset rows whose `lease_until` has passed back to `pending`. Fail after 3
  attempts with the error recorded.
- Promote `awaiting_transcript` rows older than 15 minutes to the
  `deepgram-direct` path.
- The 6-minute execution cap now applies to Workspace accounts too, so one job
  per tick, never a batch loop.
- Effort: 1.5 hours.

**Stage 1 of the test protocol passes here, with no model and no template.**

### Phase 4 — Claim matcher

- Load `Claims` from a calendar CSV export.
- Implement `matchClaim()` as a pure function against the rules above.
- Unit-test: exact hit, nearest-with-no-confirmation, two-appointments-45-minutes
  apart, empty claims list, call before any appointment.
- Effort: 2 hours.

### Phase 5 — Extraction

- `buildPrompt()`: transcript, claim metadata, template spec from `enums.json`,
  glossary, phrase bank, and the source-span requirement.
- OpenRouter client plus fallback chain, retry, and usage capture.
- `validateFields()` with exact-substring source-span checking.
- Unit-test the validator hard: fabricated span, near-miss span, whitespace-only
  difference, enum value not in list, `confidence: low`.
- Effort: 3 hours.

### Phase 6 — Doc generator

- Copy, header block, replace, highlight, "Not placed" section, `{{` assertion,
  email.
- Effort: 2 hours.

### Phase 7 — Hardening before Brandon calls

- Dropped-call behavior verified deliberately (see risks).
- A `failed` job sends an email rather than sitting silently in a sheet.
- Drafts folder shared to Brandon.
- One end-to-end dry run from the car.

---

## Test protocol

Do not skip to stage 4. Every bug found in stages 1 to 3 costs nothing. Every bug
Brandon finds in stage 4 costs his confidence.

### Stage 1 — Desk, Barton's Android

Call the number, read two minutes of anything, hang up.

Pass when: a row exists with `status = pending`, a transcript over 200
characters, an mp3 playable from `/Adjuster/Recordings/`, and no duplicate rows
for the same call. Then repeat with a **10-minute** call and compare
`transcript_chars` against duration. If a 10-minute call returns roughly 2
minutes of text, the hidden duration cap is real: switch to the
`deepgram-direct` path and record that in this spec.

Also in stage 1, deliberately: hang up at 20 seconds, and end a call by pressing
`#`. Confirm both still produce a row with usable audio.

### Stage 2 — Car, Barton driving

Same call while Maps is navigating. Read the sample narration or improvise a fake
inspection at highway speed.

Pass when: the call survives the drive, the transcript is legible, and trade terms
are recognizable enough for context repair. This is where Bluetooth mic quality
gets its verdict.

### Stage 3 — The paired artifact

Feed Brandon's real dictation (see the request list) through the full pipeline and
compare the generated draft against the report he actually wrote for that claim.
This is where the prompt gets tuned, and it can be iterated as many times as
wanted for a few dollars. Prompt iteration here runs locally through Claude Code
against the stored transcript, so only the final confirming runs cost API spend.

Pass when: the draft's populated fields agree with his report, disagreements are
explainable, and `needs_input_count` covers the things he genuinely did not say.

### Stage 4 — Brandon, one real drive

He inspects, drives away, calls the number. A draft is waiting when he gets home.

---

## Inputs required from Brandon

Ranked by how much each unblocks. Already in hand: 10 completed reports, the blank
template, a sample Xactimate PDF.

| #   | Ask                                                                                                                                                                                                                     | Blocks                     | Why it matters                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **A dictation for a claim he already wrote up.** Pick a completed report, talk through that property walk into Voice Memos for 5 to 15 minutes as if driving away from it, send both the audio and the finished report. | Stage 3, phase 5 tuning    | Worth more than everything else combined: the exact input and the exact desired output for the same claim. Without it the prompt is tuned blind.                                                             |
| 2   | Which vendor and loss type to build first.                                                                                                                                                                              | Phase 0                    | Determines which template gets flattened.                                                                                                                                                                    |
| 3   | Read-only calendar access, or a CSV export of one week.                                                                                                                                                                 | Phase 4                    | The matcher has no keys without it.                                                                                                                                                                          |
| 4   | How he names a claim out loud: address, last name, claim number, or a mix.                                                                                                                                              | Phase 4 confirmation rules | Calibrates the confirmation check against the timestamp match.                                                                                                                                               |
| 5   | Two or three of the 10 reports he considers his best, and one he thinks is weak.                                                                                                                                        | Phrase bank                | Statistical patterns show what is typical; only he can say what is good.                                                                                                                                     |
| 6   | Workspace account or personal Gmail?                                                                                                                                                                                    | Migration, quotas          | Affects Apps Script daily quotas and where the Drafts folder should live.                                                                                                                                    |
| 7   | CarPlay, or phone on a mount?                                                                                                                                                                                           | Expectation setting        | On a mount, a call and Maps coexist. On CarPlay an active call takes the screen and pushes Maps off-display; audio guidance continues, the visual map does not. Better known now than discovered in traffic. |
| 8   | Any carrier or vendor rules about AI-assisted drafting he knows of.                                                                                                                                                     | Nothing, but ask once      | Probably none, and the doc is an internal working file copied into Xactimate. Cheaper to ask than to discover.                                                                                               |
| 9   | Willingness to make three test calls in week two, and to save the number as "Field Notes".                                                                                                                              | Stage 4                    |                                                                                                                                                                                                              |

No consent issue: he is dictating alone, not recording another party.

---

## Edge cases and risk

| Risk                                                                                        | Likelihood | Impact | Signal to watch                                                                             | Mitigation                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Superseded (spec-019) — Telnyx TeXML transcription has an undocumented duration cap_       | M          | H      | First call over 2 minutes returns short text; `transcript_chars` low against `duration_sec` | Fall back to the stored Drive audio and POST to Deepgram directly. Works on either vendor and is why audio is copied on arrival.                                                                                      |
| Recording URL expires before the audio is copied                                            | M          | H      | `audio_drive_id` blank on a completed job                                                   | Still relevant — copy audio inside the webhook handler itself, never in the trigger. Alert on any `pending` row with a blank `audio_drive_id`.                                                                        |
| _Superseded (spec-019) — Duplicate callbacks from Telnyx retries after the Apps Script 302_ | M          | M      | Two rows per call                                                                           | Upsert by `capture_id`. Verified explicitly in stage 1.                                                                                                                                                               |
| _Superseded (spec-019) — Dropped call mid-recording loses everything_                       | M          | H      | Call ends early and no job appears                                                          | Test deliberately in stage 1 by hanging up at 20 seconds. Telnyx docs imply partial recordings are preserved but do not say so outright. If they are not, add `recordingStatusCallbackEvent="in-progress completed"`. |
| _Superseded (spec-019) — Bluetooth car audio mangles trade terms_                           | M          | M      | Stage 2 transcript unreadable on jargon                                                     | Switch `transcriptionModel` to `deepgram/nova-2-phonecall`, built for 8 kHz phone audio. Then lean harder on the glossary in the prompt.                                                                              |
| Claim matching picks the wrong appointment                                                  | M          | H      | Draft comes back under the wrong name                                                       | Designed as a flag rather than a silent guess: contested matches set `needs_review` and name both candidates in the draft header.                                                                                     |
| Template flattening misses a conditional section                                            | H          | M      | Draft missing a section for a given loss type                                               | Expected on the first pass. `unplaced_notes` surfaces what had nowhere to go; that is what stage 3 is for.                                                                                                            |
| OpenRouter outage or a silent fallback to a weaker model                                    | L          | M      | A draft header naming a model you did not pin                                               | Fallback chain is explicit and the model used is recorded per job. A run with no `OPENROUTER_MODEL` match fails the job rather than guessing.                                                                         |
| A fallback model ignores `json_schema` and returns prose                                    | M          | M      | Parse failure in the extractor                                                              | Pin every fallback to a structured-output-capable model. Treat a malformed response as a hard job failure, never as partial data.                                                                                     |
| Model invents a value with a plausible source span                                          | L          | H      | A number in the draft that is not in the transcript                                         | Exact-substring validation, not fuzzy. Heavily unit-tested.                                                                                                                                                           |
| Apps Script quota exhaustion after migration                                                | L          | M      | Triggers stop firing                                                                        | Confirm account type before migrating. One job per tick keeps runtime low.                                                                                                                                            |
| Webhook secret leaks via query string in logs                                               | L          | L      | None practically                                                                            | Accepted for MVP. Worst case is a junk row in a private sheet. Rotate the secret at migration.                                                                                                                        |
| Ownership migration breaks triggers                                                         | M          | M      | No drafts after handover                                                                    | Re-authorize triggers under Brandon's account as an explicit checklist step, then run one live test call before declaring it done.                                                                                    |

---

## Acceptance criteria

Engineering:

- [ ] `enums.json` and `template.gdoc` agree on every tag, asserted by `template.test.ts`.
- [ ] A call from an allowlisted number produces exactly one Jobs row, with a transcript and a playable mp3 in Drive.
- [ ] A repeated callback for the same `capture_id` updates the existing row and creates no duplicate.
- [ ] A 10-minute call returns a transcript whose length is proportionate to its duration, or the `deepgram-direct` fallback is implemented and passing.
- [ ] `matchClaim()` unit tests cover: exact hit, nearest-without-confirmation, two candidates within 45 minutes, empty claims list, call preceding all appointments.
- [ ] `validateFields()` rejects a fabricated `source_span`, a near-miss span, an out-of-enum value, and `confidence: low`, each with a test.
- [ ] Changing `OPENROUTER_MODEL` from an Anthropic ID to an OpenAI ID produces a draft with no code change.
- [ ] The model actually used (primary or fallback) is recorded on the Jobs row and printed in the draft header.
- [ ] A generated draft contains zero `{{` sequences, or the job is marked `failed` with the offending tags recorded.
- [ ] Every unpopulated field renders as a highlighted `[NEEDS INPUT: …]` marker.
- [ ] A failed job sends an email rather than failing silently.
- [ ] No secrets in the repo. All config in Script Properties, `.clasp.json` gitignored.
- [ ] ADR filed in `docs/adr/` covering the Apps Script runtime choice and the call-path capture decision.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass; `tests/unit/adjuster/` is green.

Product, in order of what actually counts:

- [ ] A call placed from a moving vehicle produces a draft Google Doc in the Drafts folder with no manual step afterward.
- [ ] The draft's sections are populated from what he actually said, in roughly his voice.
- [ ] Everything he did not say appears as a visible `[NEEDS INPUT]` marker rather than an invented value.
- [ ] **Brandon reads it and says he would edit it rather than rewrite it.**

The first three are engineering. The fourth is the product. Time to beat is 20 to
30 minutes per report by hand; a draft he finishes in 10 minutes captures most of
the value. It does not need to be perfect to be worth having.

---

## This week

1. Flatten the blank template into a Google Doc with `{{tags}}` and `enums.json`. Longest single task, so start it first.
2. Send Brandon the request list, leading with the paired dictation-plus-report ask.
3. Stand up the Telnyx number and TeXML, then run stage 1.
4. Skim the 10 reports for section structure and phrasing while waiting on Brandon.

Stage 2 lands the same week if the template work goes smoothly. Phases 5 and 6
come next week, once the paired artifact is in hand. Building the extraction
prompt before there is a target to aim at is wasted effort.

## Open questions

- Does Telnyx TeXML transcription have an undocumented duration cap? Resolved by the first 10-minute call in stage 1.
- Does Telnyx preserve a partial recording when the caller drops mid-call? Resolved by the deliberate hang-up test in stage 1.
- Which model wins on this transcript shape? Resolved in stage 3 by replaying the paired artifact through several `OPENROUTER_MODEL` values and comparing drafts against the report Brandon wrote.
