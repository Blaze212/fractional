# ADR 008 — Telnyx Retired; Retell and Dograh Are the Supported Voice Platforms

**Status:** Accepted
**Date:** 2026-09-01
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/019-adjuster-retire-telnyx.md

---

## Context

Spec 011 (the original adjuster MVP) built its call-capture path on Telnyx:
a phone number, a TeXML `<Record>` application, and — as the design evolved
during implementation — two additional Telnyx-only variants layered on top
of it (a guided, section-by-section IVR and a single-stage `<AIGather>`
flow), all reachable through `apps/adjuster/src/webhook.js` and
`apps/adjuster/src/guidedFlow.js`, with TeXML served statically from
`apps/bh-systems`.

Dograh's Notetaker voice agent was adopted alongside Telnyx (Phase 0 of the
Brandon Adjuster project, "Retell alongside Dograh" — the milestone name
reflects that Dograh landed first and Retell was added second under the same
banner) and proved out end to end: better transcript quality, no TeXML
brittleness, no guided-flow state machine to maintain. Retell was added as a
second platform under the same Notetaker-style contract shortly after, ASR
quality was compared against Telnyx's Deepgram path on real insurance
vocabulary, and both now run through the same webhook and pipeline as Dograh.

Telnyx's three flows had not received a real call in some time and existed
only as dead capture paths: dozens of functions in `webhook.js` and the
entirety of `guidedFlow.js`, three static TeXML files, a deploy-time
placeholder-substitution mechanism in `apps/bh-systems`, and several
Telnyx-only test suites. None of it exercises code Dograh or Retell depend
on except two small pure helpers (`tryJsonParse`, `stitchAIGatherMessages`),
which were extracted into `apps/adjuster/src/util.js` before the Telnyx
files were deleted.

## Decision

Telnyx is retired as a voice-capture platform for the adjuster project.
Retell and Dograh are the two supported platforms going forward. Every code
path only reachable from a Telnyx phone number has been deleted:

- The guided (section-by-section) IVR flow and its TeXML builders,
  `guidedFlow.js` in full.
- The single-stage `<AIGather>` flow (`handleSingleAIGatherEnded` and its
  routing).
- The original plain `<Record>` flow (`handleRecording`,
  `handleTranscription`, `handleCallAnalyzed`, and their supporting
  helpers), including the `ALLOWED_CALLERS` caller allowlist and
  `looksLikeTelnyxCallId` validation that only that flow needed.
- The three static TeXML files under `apps/bh-systems/public/texml/` and
  the `deploy.sh` mechanism that injected deploy ID / webhook secret
  placeholders into them.

Full mechanical inventory, including exact functions, line numbers, and the
gotchas found while removing them (an orphaned `denied()` fallthrough
argument, a stale audio-format comment, a test fixture that had to be
rewritten rather than deleted), is in
[spec-019](../specs/019-adjuster-retire-telnyx.md).

What is deliberately **not** touched:

- `WEBHOOK_SECRET` — it gates every webhook event, Dograh and Retell
  included, not just Telnyx.
- The `apps/bh-systems` Worker proxy at `/texml/gas`. The route name is a
  holdover from the reason it was first built (Apps Script's `/exec`
  endpoint always 302s, which Telnyx's TeXML callback targets couldn't
  follow), but Retell now depends on this same proxy to forward its
  `X-Retell-Signature` header as a query param — the route is shared
  infrastructure, not Telnyx-specific, and stays.
- The `guided_state` and `recording_url` columns already present in
  production Jobs-sheet rows. `jobs.js` reads headers dynamically from the
  live sheet, so there is nothing to migrate; they are noted as legacy in
  documentation only.

## Consequences

- Roughly 2,500 lines of dead code, three static assets, and a
  deploy-time secret-substitution mechanism are gone, shrinking the surface
  the planned portable-core rewrite (Phase 3 of the Brandon Adjuster
  project) has to carve a runtime-agnostic core out of.
- A production Telnyx number, if still bound to the old TeXML application,
  will start failing calls once this deploys — Apps Script no longer has
  any `recording`/`transcription`/`action`/guided/AIGather route to answer
  it with. Unbinding or redirecting that number is an operational step, not
  a code change, and is out of scope for spec-019.
- Spec-011's Telnyx-specific sections (the TeXML contract, its Phase 1, its
  Telnyx-specific risk rows) are marked superseded in place rather than
  deleted, so the original MVP's reasoning stays legible as history.
