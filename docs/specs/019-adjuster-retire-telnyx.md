# Adjuster: Retire Telnyx

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-09-01

## Objective

Remove every code path in `apps/adjuster` and `apps/bh-systems` that is only
reachable from a Telnyx phone number, without changing Dograh or Retell
behavior. This is Phase 1 of the Brandon Adjuster project (Linear project
"Brandon Adjuster", milestone "Phase 1: Retire Telnyx", team BH-systems,
features BH-47/48/49/50). Phase 0 (Retell alongside Dograh) is done; Telnyx is
no longer a supported voice platform, so its capture path — the guided
multi-section IVR, the single-stage AI-gather flow, and the original plain
`<Record>` flow from spec-011 — is dead weight that only adds surface area to
carry forward into Phase 3's portable-core rewrite.

This spec is grounded in a code-level audit against `origin/main` (commit
`a6c4c2b`), not just the Linear ticket titles, so exact function names and
line numbers below reflect what is actually in the tree.

## Non-goals

- Any change to Dograh or Retell behavior, routing, or payload handling.
- Migrating or modifying the live Jobs Google Sheet. `guided_state` and
  `recording_url` columns are left in place as legacy; only documented as
  such.
- New features of any kind. This is deletion and cleanup plus one ADR.
- Splitting this into multiple PRs. All four phases below ship as **one
  branch, one PR**, parked for human review before merge — not auto-merged.

## Business Rationale

Telnyx's guided-IVR and single-stage flows were the original MVP capture
path (spec-011) and were superseded once Dograh, then Retell, proved out as
voice platforms (Phase 0). Carrying three platforms' worth of webhook
routing, TeXML generation, and guided-state persistence forward into Phase 3
(portable core) means dragging dead code through a rewrite. Deleting it now
shrinks the surface Phase 3 has to carve into a runtime-agnostic core, and
removes a whole category of Telnyx-shaped payload bugs from ever recurring.

## Architecture

No schema or migration changes. No new Edge Functions (this is Apps Script +
a Cloudflare Worker, not the Supabase stack). The two touch points:

- **`apps/adjuster/src/webhook.js`** (`doPost` entry, `routeWebhook()`
  dispatcher) — loses every Telnyx-only route and handler.
- **`apps/bh-systems`** (the Cloudflare Worker that proxies Apps Script,
  and serves the static TeXML files) — loses the 3 TeXML static assets and
  the deploy-time placeholder substitution that injected `GAS_DEPLOY_ID` /
  `WEBHOOK_SECRET` into them. The Worker proxy itself stays — Retell still
  routes through it.

`WEBHOOK_SECRET` is **not** Telnyx-specific and is not removed: it gates
every webhook event, Dograh and Retell included (`webhook.js:58`). Only
`guidedFlow.js`'s use of it disappears with that file.

This spec warrants an ADR (`docs/adr/008-telnyx-retired.md`, Phase 4 below)
documenting why Telnyx is retired and that Retell + Dograh are the two
supported platforms going forward, per `.claude/CLAUDE.md`'s guidance to file
an ADR for changes that affect architecture.

## Implementation Phases

Land in this exact order — each phase depends on the previous one having
removed its callers first. All four are one PR.

### Phase 1 — Move shared helpers out of Telnyx files first (BH-47)

`tryJsonParse()` (`guidedFlow.js:669`) and `stitchAIGatherMessages()`
(`guidedFlow.js:399`) are Telnyx-file residents but are called from the
**Dograh** path — `fetchDograhTranscript()` in `webhook.js` (lines 825, 827).
They must survive `guidedFlow.js`'s deletion in Phase 2.

- Create `apps/adjuster/src/util.js`.
- Move `tryJsonParse()` and `stitchAIGatherMessages()` into it verbatim.
- Update `guidedFlow.js`'s own internal callers (it still uses both until
  Phase 2 deletes the file) and `webhook.js`'s two call sites to reference the
  new location. Apps Script has no module system (see spec-011's
  [Repo layout and testing](011-adjuster-mvp.md#repo-layout-and-testing)) —
  every `src/*.js` file is a global-scope script pushed together by `clasp`,
  so no import syntax changes, just confirm `util.js` is included in
  `.claspignore`/`appsscript.json`'s file list the same way every other
  `src/*.js` file is.
- `describeError()` in `log.js` is used only by shared/Dograh/Retell code
  (`webhook.js:30,891,913`, `runner.js` catch blocks) — verified zero
  Telnyx-specific callers. No code change; this phase's only action here is
  the verification itself (already done for this spec).
- Tests: no new tests required for a pure move, but run the full
  `tests/unit/adjuster/` suite to confirm nothing broke — `loadGs.ts`
  evaluates each `src/*.js` file independently in a `node:vm` sandbox, so a
  new file needs to be loadable the same way if any test exercises it
  directly.

### Phase 2 — Delete the guided and single-stage flows (BH-48)

- Delete `apps/adjuster/src/guidedFlow.js` (796 lines) entirely. It exports
  `handleGuidedStart`, `handleGuidedAction`, `looksLikeAIGatherEnded`,
  `handleGuidedAIGatherEnded`, `handleGuidedRecordingStatus`,
  `handleGuidedTranscription`, the TeXML builders (`buildSectionTeXML`,
  `buildRecordTeXML`, `buildGatherTeXML`, `buildAIGatherTeXML`,
  `texmlResponse`, `guidedActionUrl`, `xmlEscape`/`xmlEscapeAttr`), gather-
  result handling (`applyGatherResult`, `resolveGatherBranch`,
  `applyAIGatherResult`, `parseAIGatherResult`, `tryBase64Decode`), and
  guided-state persistence (`loadGuidedState`, `persistGuidedState`,
  `nextSectionId`, `reserveSectionTranscript`, `findSectionTranscript`,
  `allSectionTranscriptsIn`, `stitchGuidedTranscript`,
  `capturedFieldsFor`).
- In `webhook.js`, remove:
  - The `guided_start`/`guided`/`guided_recording`/`guided_transcription`
    routing branches (lines 173–180).
  - The AIGather dispatch block (lines 193–198):
    `looksLikeAIGatherEnded`/`isGuidedFlowCall` →
    `handleGuidedAIGatherEnded`/`handleSingleAIGatherEnded`.
  - `isGuidedFlowCall` itself, which lives in `webhook.js:322-330` (not in
    `guidedFlow.js`, despite the naming).
- Delete all 3 files under `apps/bh-systems/public/texml/`: `field-notes.xml`,
  `guided-intake.xml`, `single-stage-aigather.xml`. Neither Retell nor Dograh
  uses TeXML.
- In `apps/bh-systems/scripts/deploy.sh`: remove the `TEXML_FILES` array
  (line 21) and the backup/sed-substitute/restore trap (lines 15–38) that
  injected `GAS_DEPLOY_ID`/`WEBHOOK_SECRET` into those XML files at deploy
  time. `deploy.sh` collapses to just `npx wrangler deploy`.
- Clean the stale references to the placeholder-substitution convention in
  `apps/bh-systems/README.md` (lines 14, 19, 29) and the comment in
  `apps/bh-systems/wrangler.jsonc:11`.
- Delete `tests/unit/adjuster/guidedFlow.test.ts` (370 lines) and
  `tests/unit/adjuster/singleStageAIGather.test.ts` (214 lines) wholesale.
- In `tests/unit/adjuster/webhook.test.ts` (1241 lines):
  - Delete the `"transcript persistence"` (lines 196–255) and
    `"duplicate recording callbacks"` (257–300) describe blocks wholesale.
  - The `"doPost logging contract"` describe block (85–194) uses the Telnyx
    `'recording'` event as its example fixture (line 86). **Rewrite it** to
    use a surviving event (e.g. `dograh_notetaker`) rather than deleting it —
    the logging-contract coverage itself is not Telnyx-specific and must not
    be lost.
- Delete docs: `apps/adjuster/docs/telnyx-texml-interactive-ivr.md`,
  `apps/adjuster/docs/guided-flow-debugging-handoff.md`,
  `apps/adjuster/docs/guided-flow-diagram.md`,
  `apps/adjuster/template/interactive-call-script.txt`.

### Phase 3 — Delete the Telnyx Record flow (BH-49)

- In `webhook.js` remove: `handleRecording` (256–295), `handleTranscription`
  (297–315), `handleAction` (1008–1012), `handleCallAnalyzed` (392–423),
  `looksLikeCallAnalyzed` (448–450), `firstRecordingUrl` (435–444).
- `appendTranscriptSection()` (425–428) has no callers left once
  `handleSingleAIGatherEnded` (Phase 2) and `handleCallAnalyzed` are both
  gone. Not named in any Linear ticket, but it is orphaned dead code —
  remove it in this phase.
- Remove the routing block in `routeWebhook()` at lines 154–168
  (`callSessionId`/`fromNumber` extraction, the `recording`/`transcription`/
  `action` event branches) and line 206–208 (`looksLikeCallAnalyzed`
  dispatch). The function's fallthrough
  `return denied('unknown_event', callSessionId, 'OK')` (line 210)
  references `callSessionId`, which only existed because of the block being
  removed — change it to reference an empty string or whatever identifier
  remains valid at that point once the Telnyx extraction is gone.
- Remove `ALLOWED_CALLERS`/`isAllowedCaller` (`webhook.js:1047-1050`) and
  `looksLikeTelnyxCallId` (1052–1054) — confirmed zero non-Telnyx callers.
- Remove `promoteStaleAwaitingTranscript()` from `jobs.js:282-299` and its
  call site in `runner.js`'s `runPipelineTick()`. `awaiting_transcript`/
  `awaiting_recording` statuses are written only by `handleRecording`/
  `handleTranscription`, both deleted this phase, so this is safe.
  `reclaimStuckJobs()` (`jobs.js:252`, called from the same tick) is generic
  lease-reclaim by status, **not** Telnyx-specific — leave it untouched.
- Remove `firstParam()` (`webhook.js:1056-1061`) — its only remaining callers
  after the above are inside `guidedFlow.js`, already deleted in Phase 2 —
  and the top-of-file comment (lines 1–12) documenting Telnyx's PascalCase
  field-name hedge.
- **Do not remove `WEBHOOK_SECRET`.** It gates every event, Dograh and Retell
  included, not just Telnyx.
- `guided_state`/`recording_url` Jobs-sheet columns: `jobs.js` reads headers
  dynamically from the live sheet (no fixed schema array), so this is a
  documentation-only instruction — note them as legacy in
  `apps/adjuster`'s README (done in Phase 4). No code change, no Sheet
  migration.
- `copyRecordingToDrive()`'s `'mp3'` fallback-extension comment
  (`webhook.js` ~1014–1019) goes stale once its only `'mp3'`-passing caller
  (`handleRecording`) is gone — every remaining caller passes `'wav'`.
  Update the comment to match.

### Phase 4 — Docs (BH-50)

- Write `docs/adr/008-telnyx-retired.md` (next number; 001–007 exist, 007 is
  `dual-transcription-and-verbatim-merge`) covering: why Telnyx is retired,
  that Retell and Dograh are the two supported voice platforms going
  forward, and a pointer to this spec for the mechanical deletion record.
- In `docs/specs/011-adjuster-mvp.md`, mark superseded (do not delete —
  archive in place with a note) the Telnyx-specific sections: "Telnyx first,
  Twilio as fallback" under Context, the entire "Telephony: TeXML contract"
  section (attribute table + XML sample), the Telnyx-derived Jobs-sheet
  column documentation, "Phase 1 — Telnyx number and TeXML" under
  Implementation phases, and the Telnyx-specific rows in the Edge
  cases/risk table (duration cap, recording URL expiry, dropped-call,
  Bluetooth mangling). Leave the non-Telnyx sections (matcher, extraction/
  OpenRouter, trust boundary, doc generator, acceptance criteria) as-is —
  Retell and Dograh still go through the same downstream pipeline spec-011
  describes.
- Trim the Telnyx mentions in `apps/adjuster/template/README.md` (lines 291,
  297–298, 312, 357, 371, 381–385, 392) describing the old Record-flow
  behavior and `firstRecordingUrl()`. Add the note that `guided_state` and
  `recording_url` Jobs-sheet columns are legacy, per Phase 3.

## Edge Cases & Risk

| Risk                                                                                                                                    | Likelihood  | Impact | Mitigation                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deleting `guidedFlow.js` before extracting `tryJsonParse()`/`stitchAIGatherMessages()` breaks the live Dograh transcript-fetch path     | M           | H      | Phase 1 extracts both functions first and is verified with the full test suite before Phase 2 touches `guidedFlow.js`                                                                        |
| `webhook.test.ts`'s logging-contract test silently loses coverage if its Telnyx fixture is deleted instead of rewritten                 | M           | M      | Phase 2 explicitly rewrites (not deletes) the `"doPost logging contract"` block to use a surviving event                                                                                     |
| Orphaned dead code (`appendTranscriptSection`, stale `'mp3'` comment) missed because it wasn't named in the original Linear tickets     | L           | L      | Both are called out explicitly in this spec's Phase 3, found via code audit rather than ticket titles alone                                                                                  |
| `routeWebhook()`'s `denied('unknown_event', callSessionId, ...)` fallthrough references a variable removed earlier in the same function | H if missed | M      | Phase 3 explicitly calls out fixing this reference                                                                                                                                           |
| A production Telnyx call still lands mid-deploy (number not yet unbound) and 404s or silently drops                                     | L           | M      | Out of scope for this spec (number unbinding is a Phase 0/ops action, not code) — confirm with Barton the Telnyx number is already unbound or scheduled for unbinding before merging this PR |
| `apps/bh-systems` deploy breaks because `deploy.sh` still references deleted TeXML files elsewhere (e.g. CI config)                     | L           | M      | Grep the whole repo for `texml` references after Phase 2's deletions, not just the files named in this spec                                                                                  |

## Acceptance Criteria

- [ ] `apps/adjuster/src/util.js` exists with `tryJsonParse()` and
      `stitchAIGatherMessages()`; Dograh's `fetchDograhTranscript()` still
      works (covered by existing Dograh tests).
- [ ] `apps/adjuster/src/guidedFlow.js` is deleted.
- [ ] `apps/bh-systems/public/texml/` is empty or removed; `deploy.sh` no
      longer references `TEXML_FILES`.
- [ ] `tests/unit/adjuster/guidedFlow.test.ts` and
      `singleStageAIGather.test.ts` are deleted; `webhook.test.ts`'s
      `"doPost logging contract"` block passes using a non-Telnyx fixture.
- [ ] `handleRecording`, `handleTranscription`, `handleAction`,
      `handleCallAnalyzed`, `looksLikeCallAnalyzed`, `firstRecordingUrl`,
      `appendTranscriptSection`, `ALLOWED_CALLERS`, `isAllowedCaller`,
      `looksLikeTelnyxCallId`, `firstParam`, and
      `promoteStaleAwaitingTranscript` are all removed with no remaining
      references (`grep -rn` for each name returns nothing under
      `apps/adjuster` and `tests/unit/adjuster`).
  - [ ] `WEBHOOK_SECRET` still gates Dograh and Retell events — confirmed
        unchanged.
- [ ] `docs/adr/008-telnyx-retired.md` exists.
- [ ] `docs/specs/011-adjuster-mvp.md`'s Telnyx-specific sections are marked
      superseded/archived, not deleted; non-Telnyx sections are untouched.
- [ ] `apps/adjuster/template/README.md` no longer describes the Telnyx
      Record flow as current behavior; legacy Jobs-sheet columns are noted.
- [ ] `pnpm typecheck`, `pnpm test` (or the package-level equivalent covering
      `tests/unit/adjuster/`), `pnpm format`, and `pnpm lint` all pass.
- [ ] No Dograh or Retell test in `tests/unit/adjuster/` changes behavior
      (only the logging-contract fixture rewrite touches shared test code).
- [ ] All four phases land as commits on one branch, one PR, opened against
      `main` and left unmerged for review.
