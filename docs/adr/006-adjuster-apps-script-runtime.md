# ADR 006 — Adjuster MVP Runs on Google Apps Script, Not the TypeScript/Supabase Stack

**Status:** Accepted
**Date:** 2026-08-15
**Owner:** CareerSystems / adjuster
**Related spec:** docs/specs/011-adjuster-mvp.md

---

## Context

The Adjuster MVP's deliverable is a draft inspection report as a Google Doc,
built from a Google Doc template, dropped into a Google Drive folder shared
with the adjuster. `.claude/CLAUDE.md` sets TypeScript/Node/Vite + Supabase
Edge Functions as the default stack for this repo, but that stack has no
native path to `DocumentApp`/`DriveApp`/`CalendarApp`: reaching Drive/Docs
from a Supabase Edge Function would mean a Google service account, OAuth
plumbing, and a domain-wide delegation grant on someone else's Google
Workspace, none of which exists yet and all of which is out of proportion for
a single-user MVP whose entire job is to prove a workflow, not scale it.

## Decision

The Adjuster MVP is built and deployed as a Google Apps Script project
(`apps/adjuster/`), pushed with `clasp`, not as a Supabase Edge Function.

Consequences accepted deliberately:

- **No module system.** Apps Script has no `import`/`export`; source files
  declare plain top-level functions and share a single global namespace at
  runtime. This repo's usual TypeScript module conventions do not apply
  inside `apps/adjuster/src/`.
- **No `tsc` coverage.** Apps Script's runtime is not Node/V8-via-TypeScript;
  these files are plain `.js` and are not part of any `tsconfig.json` project
  or the root `pnpm typecheck` graph.
- **Pure logic still gets real unit tests.** `matchClaim()`, `validateFields()`,
  and `buildPrompt()` are written with no dependency on Apps Script globals
  (`DocumentApp`, `PropertiesService`, `UrlFetchApp`, etc.) so they can be
  loaded into a `node:vm` sandbox (`tests/unit/adjuster/loadGs.ts`, ~15 lines)
  and exercised with real `vitest` assertions. This satisfies the
  `.claude/CLAUDE.md` "all changes MUST be accompanied by unit tests" rule
  for the logic that determines correctness. Surface code that only wires
  Apps Script globals together (`webhook.js`, `runner.js`, `docgen.js`,
  `jobs.js`) is not unit tested; it is covered by the spec's four-stage
  manual test protocol (desk call → car call → paired-artifact replay →
  Brandon's real drive) instead, because a mock of `DocumentApp`/`UrlFetchApp`
  would test the mock, not the integration.
- **Secrets live in Apps Script Script Properties, not Doppler.** There is no
  Doppler-managed environment for an Apps Script project. `WEBHOOK_SECRET`,
  `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, and friends are set directly in
  Script Properties on the Apps Script project; `.clasp.json` (which holds
  the script ID) is gitignored. Nothing Adjuster-related goes in this repo's
  `.env` files.
- **Deploys via `clasp push`, not the CI/Cloudflare pipeline.** The
  `apps/adjuster` directory is a pnpm workspace member in name only — it has
  no `package.json`, is not built by `pnpm build`, and is not deployed by the
  Cloudflare Pages pipeline that ships `apps/portal`.
- **All model calls still go through OpenRouter**, consistent with
  [010-openrouter-ai-client.md](../specs/010-openrouter-ai-client.md), via a
  hand-rolled ~50-line `UrlFetchApp` wrapper (`apps/adjuster/src/core/openrouter.js`)
  rather than an SDK, because no maintained OpenRouter or OpenAI/Anthropic
  client library targets the Apps Script runtime.

## Alternatives Considered

**Supabase Edge Function + Google service account.** Reaches Drive/Docs but
requires provisioning a service account, sharing every target folder/doc
with it, and handling OAuth token refresh — a full day of plumbing before any
adjuster-facing logic exists, for a single-user MVP whose success metric is
"does Brandon edit the draft or rewrite it," not infrastructure purity.
Rejected for the MVP; worth revisiting if/when this expands past one user.

**A device app that captures audio directly.** Rejected in the spec itself
(see "Context: decisions already settled" in docs/specs/011-adjuster-mvp.md)
because Barton is on Android and Brandon is on iPhone, and iOS blocks
third-party apps from tapping call audio directly. A phone call behaves
identically on both platforms; testing on one proves nothing about the other.

## Resolved limitation — WEBHOOK_SECRET no longer sits in git

`apps/bh-systems/public/texml/field-notes.xml` briefly embedded
`WEBHOOK_SECRET` in plain text, in the `t=` query param on every callback
URL. The original reasoning accepting that (recorded below for context) was
that the file is served with **no access control** at
`https://bh-systems.com/texml/field-notes.xml`, so the secret is already
fully public the moment it's live — committing it to git adds no exposure
beyond what anyone can already `curl`. The spec's own risk table accepted
this: worst case is a junk row in a private Google Sheet, nothing
destructive is gated behind it.

That reasoning does not survive past a single-user MVP, so it was replaced
before it needed to: `field-notes.xml`, `guided-intake.xml`, and
`single-stage-aigather.xml` now carry `DEPLOY_ID`/`SECRET` placeholders in
git, never the real values. `apps/bh-systems/scripts/deploy.sh` (run via
`npm run deploy`) substitutes `GAS_DEPLOY_ID`/`WEBHOOK_SECRET` from the
environment (or a gitignored `apps/bh-systems/.env`) into those files only
for the duration of `wrangler deploy`, then restores the committed
placeholders regardless of whether the deploy succeeded. The real
deployment ID and webhook secret now exist only in the environment/`.env`,
never in git history or a publicly fetchable file.

Real webhook signature verification (checking Telnyx's Ed25519 signature
from Apps Script instead of a shared-secret query param) is still not
implemented — worth revisiting if this expands past Brandon or starts
gating anything with a higher blast radius than "junk sheet row."

## Deployment pitfalls hit during Stage 1 setup

Two `clasp`/manifest gotchas cost real debugging time getting the first
deployment live; recording them so the next deploy (e.g. onto Brandon's
account at migration) doesn't repeat it:

- **`clasp create --rootDir .` silently overwrites an existing
  `appsscript.json`** in that directory, including the `webapp` block. If
  you run `clasp create` against a directory that already has this repo's
  manifest checked out, diff `appsscript.json` against git immediately after
  and restore it before the first `clasp push` — otherwise the deployment
  has no web app entry point at all and every request to `/exec` 404s with
  no indication why.
- **`access: "ANYONE"` is not public.** It means "anyone with a Google
  account" — an anonymous caller (Telnyx's webhook servers, `curl`, anything
  that can't present Google credentials) gets a 401 "unable to open the
  file" page instead of executing the script. A truly public web app, which
  a third-party webhook requires, needs `access: "ANYONE_ANONYMOUS"`. This
  repo's `appsscript.json` is set correctly; the failure mode above only
  bites if that value regresses to `"ANYONE"` on some future redeploy.

Both are silent failures — Apps Script gives no error pointing at either
cause. The `Raw` tab (or a direct `curl` against the deployment's `/exec`
URL) is the fastest way to tell "request never reached the script" (404),
"reached Apps Script but rejected before running" (401), and "ran
successfully" (the 302 redirect to `script.googleusercontent.com`, which is
expected and harmless — see the TeXML contract section of the spec) apart
from each other.

## Consequences

- This repo now contains one non-TypeScript, non-Supabase surface. Anyone
  extending `apps/adjuster/` should keep pure decision logic
  (matching, validation, prompt construction) free of Apps Script globals so
  it stays testable; anything that must call `DocumentApp`/`UrlFetchApp`/
  `PropertiesService` directly is accepted as untested-by-vitest and relies on
  the manual test protocol instead.
- Migrating the MVP from Barton's Google account to Brandon's (planned after
  stage 4 passes) means transferring Drive/Doc/Script ownership and
  re-authorizing triggers — tracked as a separate risk in the spec, not a
  concern for this ADR.
- If the Adjuster product grows beyond a single user, the Apps Script
  approach should be re-evaluated; the OpenRouter client, matcher, validator,
  and prompt builder are pure enough to port to a Supabase Edge Function with
  minimal rewriting if that day comes.
