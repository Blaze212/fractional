# Dograh-vs-Retell A/B Call Runbook

Part of spec 017 (`docs/specs/017-adjuster-dograh-regression-guard.md`).
Once Retell exists as a second voice platform, this is how a human verifies
that a call to the Retell number produces the same result as the same call
made to the Dograh number — before trusting Retell for real claims.

This procedure cannot be run yet: there is no live Retell number. It is
written now so it's ready to execute the day one exists, and the comparison
script it uses (`scripts/adjuster-compare-ab-drafts.mjs`) is already written
and unit-tested (see `tests/unit/adjuster-compare-ab-drafts.test.ts`).

## When to run this

- Before pointing any real claim traffic at the Retell number for the first
  time.
- After any change to the Retell ingest path, prompt, or shared pipeline
  code that could plausibly change what a Retell call produces.
- Periodically (e.g. monthly) as a spot check while both platforms are live,
  to catch drift.

## Prerequisites

- Both numbers are live and pointed at working agents (Dograh's existing
  number, Retell's number once it exists).
- Access to the Jobs sheet (`JOBS_SHEET_ID` — see `apps/adjuster/src/config.js`).
- A copy of `apps/adjuster/template/sample-call-script.txt` (or
  `interactive-call-script.txt` for the guided flow) to read verbatim — using
  the same script on both calls is what makes the diff meaningful. Pick
  whichever script matches the flow both platforms are meant to run.

## Procedure

1. **Place the Dograh call.** Call the Dograh number and read the sample
   script verbatim, exactly as written. Let the call complete normally, then
   wait for the `dograh_notetaker` webhook to land (usually within a minute
   or two of hangup — check the Raw sheet tab for a `dograh_notetaker` row
   with a recent timestamp).

2. **Place the Retell call.** Call the Retell number and read the _exact
   same_ script, same words, same order. Let it complete and wait for its
   resulting Jobs row to appear the same way.

3. **Pull both Jobs rows.** In the Jobs sheet, find each call's row by its
   `capture_id` (or by `call_started_at` matching roughly when you placed
   each call). For each row, copy every column into a JSON object —
   column name as the key, cell value as the value — and save as
   `dograh-row.json` and `retell-row.json`. (A one-off Apps Script function
   that does this export automatically is worth adding once the row shape
   for Retell is settled — not required for this manual procedure.)

4. **Run the diff.**

   ```bash
   node scripts/adjuster-compare-ab-drafts.mjs dograh-row.json retell-row.json
   ```

   By default this ignores fields that are expected to differ between any
   two calls or any two platforms by design (see `DEFAULT_IGNORED_FIELDS` in
   the script — `capture_id`, `source`, `transcript_source`, timestamps,
   `recording_url`, `audio_drive_id`, `call_folder_id`). Everything else —
   every extracted claim field (insured name, address, roof type, cause of
   loss, etc.) — is compared for an exact match.

5. **Read the report.**
   - `PASS` — every extraction field matches. Retell is producing the same
     draft as Dograh for this script. Good to go for that call shape.
   - `FAIL` — one or more fields differ. Before assuming Retell is wrong,
     check the actual transcript both platforms captured (the `transcript`
     field in each row) — a mismatch can come from Retell/Dograh
     mishearing something differently, not necessarily from a pipeline bug.
     If the transcripts agree but the extracted fields don't, that's a real
     extraction-pipeline discrepancy worth filing.

6. **Repeat with a few different scripts.** One clean pass isn't enough
   signal — run this against at least the standard sample script and one
   edge-case script (a call with an unusual answer, a "needs input" field, a
   mortgage-status variant) before trusting Retell broadly.

## What "same script, different result" can mean

- A genuine STT/ASR difference between platforms (Dograh's and Retell's
  transcription may use different underlying models) — check the raw
  transcripts first, per step 5.
- A prompt/extraction difference specific to how Retell's ingest path feeds
  the shared pipeline (see the Retell ingest spec, once it exists) — file
  against that work, not this one.
- A genuine regression in the shared pipeline (`transcription.js`,
  `runner.js`) introduced while adding Retell support — this is exactly what
  spec 017's contract tests in `tests/unit/adjuster/webhook.test.ts` exist to
  catch before it ships, so a FAIL here alongside a passing contract-test
  suite likely points at Retell-specific code rather than a Dograh
  regression.

## Rollback check

If a FAIL here is bad enough to pull Retell traffic, unbinding the Retell
phone number from its agent is the entire rollback — no code change is
required. See "Rollback Path Confirmation" in
`docs/specs/017-adjuster-dograh-regression-guard.md` for why: nothing
downstream of the webhook (`transcription.js`, `runner.js`) treats
`job.source` as anything other than a loose `=== 'dograh'` / `!== 'dograh'`
check, so Dograh calls keep working exactly as before the moment Retell
traffic stops.
