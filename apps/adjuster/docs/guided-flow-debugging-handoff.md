# Guided flow — debugging handoff (2026-08-20)

Written after a live-call debugging session on `guided-intake.xml` / `guidedFlow.js`. Two
real, unresolved bugs remain, both discovered through actual test calls rather than
documentation (Telnyx's docs have real gaps here — noted below where that's the case).
This is meant to be a self-contained handoff: what's fixed, what's broken, what's been
ruled out, and what to try next.

## What's already fixed (for context — not open issues)

1. **Apps Script's `/exec` endpoint always 302s** to a `script.googleusercontent.com` URL
   for its real response body — unconditional Apps Script behavior, not a
   misconfiguration. Telnyx's TeXML `Redirect`/`action`/callback fetches don't follow that
   hop, so every URL pointed straight at `script.google.com` silently failed. Fixed with a
   Cloudflare Worker proxy at `https://www.bh-systems.com/texml/gas`
   (`apps/bh-systems/src/worker.js`) that follows the redirect server-side and hands
   Telnyx one definitive response. `guided-intake.xml` and `guidedActionUrl()` in
   `guidedFlow.js` both route through it now. Confirmed working on live calls.
2. **Record's silence timeout** tuned from 4s to 1s (`buildRecordTeXML()` in
   `guidedFlow.js`) to cut down on dead air between questions. Confirmed live via
   Telnyx's own `record_start` event (`"timeout_secs": 1`).
3. Apps Script code is deployed via `clasp`, not through any repo build step — see
   **Deployment mechanics** at the bottom before touching any of this.

## Open issue 1 — the second `<Record>` verb in a call never completes

### Symptom

`contact_info` (the _first_ `<Record>` in the guided flow) works completely, every time:
recording starts, ends normally (via silence timeout, in every observed case), and its
`recordingStatusCallback` / `action` / `transcriptionCallback` all fire and get processed.

`claim_info` — the _second_ `<Record>`, built by the exact same `buildRecordTeXML()`
function, differing only in `say` text and `maxLength` — reliably never completes. The
recording clearly **starts** (confirmed via live partial-transcript events streaming in
mid-call, e.g. a `" claim"` fragment with `confidence: 0, is_final: false`), but none of
its three independent stop conditions ever fire:

- Silence timeout (1s) — never triggers.
- `maxLength` (30s hard cap) — never triggers, even ~56+ seconds into the attempt.
- Explicit DTMF `finishOnKey="#"` — tested directly on a live call, caller pressed `#`,
  recording did not stop.

The call just sits with no further progress until the caller manually hangs up, or in one
case the app itself terminated the call after the caller had already given up.

### Evidence

- Call `3f901386-9ccf-11f1-affb-862ede0d8d71` (2026-08-20 ~19:42–19:43 UTC — this is the
  call examined in most detail): `contact_info`'s Record fully round-tripped
  (`RecordingDuration` 9–13s across different test runs, transcript captured correctly,
  its `action` callback correctly returned `claim_info`'s TeXML — independently
  reverified via a synthetic `curl` through the proxy, byte-structurally identical in
  shape to `contact_info`'s working TeXML). `claim_info`'s `<Say>` audibly played. Live
  transcription streamed in. No `recordingStatusCallback`, `action`, or
  `transcriptionCallback` event for `step=claim_info` ever appeared in the Apps
  Script/Raw-sheet logs, for the full ~56 seconds until hangup.
- Reproduced deterministically across 3+ separate live test calls.
- **`claim_info`'s own `record_start` event (from Telnyx's raw per-call event log) was
  never actually captured during this session**, despite being asked for twice — this is
  the single highest-value piece of evidence still missing. Compare its `source`,
  `max_length`, and `timeout_secs` fields against `contact_info`'s (which showed
  `"source": "RecordVerb"`, `"max_length": 45`, `"timeout_secs": 1`) — a difference there
  would likely explain everything.

### Ruled out

- **Lock contention** — `withJobLock()` uses `LockService.getScriptLock()`, a
  project-wide lock also used by `runner.js`'s tick. Considered and ruled out: `doPost()`
  logs `webhook.received` as its literal first line, before any lock is touched. Lock
  contention could explain a _delayed_ log line, never a completely absent one — and we
  see zero log lines for `claim_info`'s callbacks, not delayed ones.
- **Malformed TeXML** — ruled out. `claim_info`'s `action`/`recordingStatusCallback`/
  `transcriptionCallback` URLs were independently verified (synthetic `curl` through the
  proxy) to be well-formed and structurally identical to `contact_info`'s.

### Documentation checked — genuinely no answer found

Both Telnyx's `<Record>` verb reference page and the full API reference dump
(`developers.telnyx.com/public/llms/calling/voice-api-full.txt`) were searched explicitly
for: sequential/multiple `<Record>` verb behavior within one call, DTMF-during-Record
detection requirements, `maxLength` enforcement guarantees, and transcription-vs-
completion-detection conflicts. **All four came back "not covered."** This is a real gap
in Telnyx's public docs, not a research shortcut.

### Leading hypothesis (unconfirmed)

Something about being the _second_ `<Record>` verb reached via a TeXML `action=`-callback
chain — as opposed to the first verb executed from the call's initial document fetch —
causes Telnyx to not properly arm that Record instance's stop conditions. This may be
architecturally related to what open issue 2 found: TeXML's verb-chaining-via-`action=`
model may simply not be fully symmetric/reliable past the first hop for some verb types.

### Next steps

1. Get `claim_info`'s own `record_start` event and diff it against `contact_info`'s.
2. Run the positional swap test that was proposed but never completed: make `claim_info`
   the very _first_ section in the call (ahead of `contact_info`) and see whether it then
   works fine while whatever runs second breaks. This would conclusively separate
   "`claim_info`-specific" from "second-verb-in-a-call" as the root cause.
3. If it's confirmed positional, escalate to Telnyx support directly with the
   CallSessionId and this writeup — documentation is exhausted on our end.
4. If open issue 2's Call Control rewrite happens, consider whether Record steps should
   move to `record_start`/`record_stop` REST commands there too — may resolve this as a
   side effect.

## Open issue 2 — AIGather's result never actually continues the call

### Symptom

`<AIGather>` (used for `assignment`, `mortgage`, `coverage`, `risk_information`,
`risk_siding_year`, `roof_shingle`, `exterior`, `personal_property`, `mitigation` — 9 of
~17 sections) plays its greeting and runs a live AI-driven conversation successfully, but
the call ends shortly after — either the app hangs up (`HangupSource: "callee"`) or the
caller eventually gives up — without ever advancing to the next section.

### Root cause (confirmed via Telnyx's official docs this time)

"Gather using AI" is fundamentally a **Call Control REST command**
(`POST /v2/calls/:call_control_id/actions/gather_using_ai`), not a self-contained TeXML
verb with a synchronous `action=` response cycle the way `<Record>`/`<Gather>` are.

- Its result is delivered via a **`call.ai_gather.ended` webhook event**, sent to
  whatever URL is configured as the account's Call Control webhook — **not** to the
  `<AIGather>` verb's own `action=` attribute. In this setup that happens to be the same
  URL used for the plain call-status callbacks (`call_initiated`, `call_hangup`, etc.):
  the proxy URL with no `event=` param.
- The actual payload observed (twice, on two separate live calls) is form-encoded with:
  `AccountSid`, `CallSessionId`, `CallSid`, `CallSidLegacy`, `CallStatus`
  (`"conversation_ended"`), `ConnectionId`, `ConversationId`, `DurationSec`, `LlmModel`
  (observed: `Qwen/Qwen3-235B-A22B`), `Messages` (JSON array of `{role, content,
timestamp}` conversation turns), `Reason` (observed: `"normal"`), `SttModel`
  (`distil-whisper/distil-large-v2`), `TransferStatus`, `TtsModelId` (`Natural`),
  `TtsProvider` (`telnyx`), `TtsVoiceId` (`brook`), `t`. **No structured field matching
  our `<Parameters>` JSON Schema appears anywhere in this payload** — only the raw
  conversation transcript.
- **Confirmed empirically that returning TeXML in response to this webhook does not
  continue the call.** After the detection/handler fix below was deployed and confirmed
  working (`webhook.accepted` instead of `webhook.denied`), the call still hung up ~3
  seconds later regardless of what TeXML was returned.
- Telnyx's docs (`api-reference/call-commands/gather-using-ai` +
  `public/llms/calling/voice-api-full.txt`) confirm the intended pattern: after
  `call.ai_gather.ended`, issue a **new** Call Control REST command against the same
  call (`call_control_id`, which is the same value as our `CallSid`) — `.../actions/speak`,
  `.../actions/gather_using_ai` again, `.../actions/record_start`, etc. — authenticated
  with `Authorization: Bearer <Telnyx API key>`, and a unique `command_id` per command
  (duplicate `command_id`s within 60s are ignored, per docs). **A TeXML-driven call can
  still accept these commands mid-call** — but there's no documented way back from
  "REST-command mode" to "TeXML action= mode" once you've made that first call.

### What's already built and confirmed working

In `apps/adjuster/src/guidedFlow.js` / `webhook.js`:

- `looksLikeAIGatherEnded(params)` — detects the event by shape (`Messages` +
  `ConversationId` both present; there's no `event=` param to key off, since this
  arrives at the account-level status-callback URL, not our own per-step URL).
- `handleGuidedAIGatherEnded()` — looks up job state, confirms `currentStep` is an
  `aigather` section, stitches `Messages` into a `Q:`/`A:` transcript, advances
  `state.currentStep`, persists. **Confirmed via live call**: runs successfully,
  `webhook.accepted` (previously fell through to `webhook.denied` / `unknown_event`
  before this fix existed).
- `stitchGuidedTranscript()` updated to include `aigather`-verb sections' transcripts
  alongside `record`-verb ones.
- **What it does _not_, and per the finding above _cannot_, meaningfully do**: return
  TeXML that actually continues the call. Whatever TeXML it currently returns is
  discarded by Telnyx.

### Secondary, still-unexplained pattern

On both live calls where `assignment`'s AIGather ran, the caller's answer was cut off by
the AI assistant at almost the identical point — `"I contacted."` / `"I made contact."` —
before naming an actual person, followed by the assistant saying `"Sure,"`, and the
conversation ending with `Reason: "normal"` despite the schema's required fields
(`contacted_party_name`, `present_at_inspection`) never being satisfied. Worth
investigating (`interruption_settings`, `user_response_timeout_ms` on the request body)
once call continuation itself is solved — an interruption doesn't matter if the call
can't advance to the next question either way.

### Options going forward — none implemented, this is a real decision point

1. **Full Call Control REST rewrite (not started, needs a new credential).** Add a
   `TELNYX_API_KEY` script property, write a `UrlFetchApp`-based Telnyx REST client in
   Apps Script, and rewrite `handleGuidedAIGatherEnded()` — and everything reachable
   after the first `aigather` section — to issue REST commands instead of returning
   TeXML. Scope: `contact_info`/`claim_info` stay pure TeXML (before the first
   `aigather`); everything from `assignment` onward (9 `aigather` sections plus the
   interleaved `record`/`gather` sections between them) needs a Call-Control-command
   equivalent built. This is a real second implementation surface, not a tweak.
2. **The "mix TeXML with a REST-driven back half of the same call" shape itself** — flagged
   explicitly as architecturally awkward: two different continuation models glued
   together mid-call, a doubled implementation surface per verb type, a new external
   credential/API surface, and **no confirmed end-to-end multi-turn example in Telnyx's
   own docs** (their reference material explicitly doesn't provide one). This is the
   "hacky fix" under consideration, not a clean design — worth a small proof-of-concept
   before committing further engineering to it (see next point).
3. **Recommended before committing further**: a minimal spike — hand-code exactly one
   REST call (`speak` or `gather_using_ai`) fired from `handleGuidedAIGatherEnded()`
   against a live call's `call_control_id`, to prove Telnyx actually accepts and acts on
   a REST command issued against a TeXML-originated call, before investing in rewriting
   every remaining section.
4. **Alternative, explicitly not decided against**: drop `aigather`-verb sections
   entirely in favor of plain `<Record>` (free-form) for all 9 of them, relying on the
   same downstream OpenRouter extraction pass (`runner.js` / `prompt.js`) that already
   extracts structured fields from free-form transcripts in the single-shot flow. This
   was raised and explicitly set aside earlier in the session _because_ open issue 1
   (Record chaining) is itself unresolved — it's a much smaller change than option 1 and
   worth reconsidering once/if issue 1 gets root-caused.

## Cross-cutting notes for whoever picks this up

- **Deployment mechanics.** This Apps Script project is managed via `clasp`
  (`apps/adjuster/.clasp.json`). `clasp push` only updates the project's saved HEAD code
  — it does **not** affect what's live at the `/exec` URL. You must also run
  `clasp deploy -i <deploymentId>` targeting the _specific existing_ deployment ID that
  the Cloudflare proxy's `GAS_EXEC_URL` secret references, or you'll create an orphaned
  new deployment at a different URL and see no change on live calls. The pinned
  deployment ID currently in use is stored only as the Cloudflare Worker's
  `GAS_EXEC_URL` secret (`apps/bh-systems`, set via `wrangler secret put`) — deliberately
  not committed to git, matching this repo's existing `DEPLOY_ID`/`SECRET` placeholder
  convention in `field-notes.xml`/`guided-intake.xml`. Run
  `npx @google/clasp deployments` from `apps/adjuster` to find it if you don't have it.
- **Diagnostic technique that worked repeatedly this session**: Apps Script's own
  Raw-sheet/Cloud-Logging output (`webhook.received`/`accepted`/`denied`) only tells you
  what _our_ code did — it never tells you what Telnyx itself did on the wire. The
  single most useful evidence source has been Telnyx's own per-call event log/debug
  export (`call_initiated`, `record_start`, `speak`, `transcription`, `call_hangup`,
  etc., with full JSON payloads). Cross-referencing the two is what cracked both the
  redirect-302 issue and the AIGather webhook-shape issue. `clasp logs` does **not**
  work in this environment — no GCP project is linked to the Apps Script project.
- **The account-level call-progress-events webhook** (configured directly in the Telnyx
  dashboard, outside this repo) was originally pointed at the bare, 302-prone
  `script.google.com` URL. It was repointed to
  `https://www.bh-systems.com/texml/gas?t=<secret>` mid-session — worth confirming that
  actually stuck, since it lives outside version control and is easy to lose track of.
