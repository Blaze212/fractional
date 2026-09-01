# Retell Inbound-Call Hook for Dynamic Variables

**Status:** Ready for implementation
**Owner:** Barton
**Last updated:** 2026-08-31

Corresponds to Linear BH-42 (parent), BH-76 through BH-80.

## Objective

Dograh's Beta Notetaker workflow already POSTs to Apps Script
(`event=dograh_pre_call`) the instant an inbound call arrives, before the
agent speaks, to fetch a suggested claim match and a candidate list for the
live agent to reason over. Phase 0 of the Brandon Adjuster project adds
Retell as a second voice platform (`apps/adjuster/`); Retell needs the same
pre-call priming, delivered through Retell's own inbound-webhook contract.
This spec extracts the existing claim-suggestion logic out of
`handleDograhPreCall()` into one shared, platform-agnostic builder, adds a
`event=retell_inbound` route that returns Retell's expected
`{ call_inbound: { dynamic_variables } }` shape, and confirms the whole
round trip (Worker proxy → Apps Script cold start → Sheet read) fits inside
Retell's webhook timeout — adding `CacheService` caching if it doesn't.

## Non-goals

- `override_agent_id`, `override_agent_version`, `agent_override`, or
  `reject` in Retell's `call_inbound` response — only `dynamic_variables` is
  in scope for this spec.
- Any change to post-call claim matching (`matcher.js`, `llmMatcher.js`,
  `runner.js`'s two `getClaims()` calls). Those stay on a live Sheet read;
  see Architecture for why the new cache is scoped to the pre-call path only.
- Retell agent/workflow configuration itself (prompt authoring, webhook URL
  registration in the Retell dashboard) — this spec is Apps Script + Worker
  code only.
- Ingesting Retell's post-call webhook (recording/transcript delivery) —
  that's spec 014 (Retell ingest), a separate piece of Phase 0. This spec
  covers only the pre-connect inbound hook.
- Changing `WEBHOOK_SECRET`/auth scheme. Retell's webhook reuses the same
  `?t=<secret>` shared-secret gate every other event already goes through in
  `routeWebhook`.

## Business Rationale

Without this hook, a caller on Retell gets no claim-suggestion priming at
all — the agent starts cold every time, even when the caller almost
certainly just finished an appointment that's sitting in the Claims sheet.
Dograh callers already get this; shipping the Retell equivalent is required
before Retell can be a real second platform rather than a strictly worse one.

## Architecture

### Current state (grounded in `apps/adjuster/src/webhook.js`)

`handleDograhPreCall()` (lines ~595-623) does three things in one function:

1. Builds the claim-suggestion payload: reads `getClaims()`, picks the most
   recently completed appointment within `PRE_CALL_SUGGESTION_WINDOW_HOURS`
   (6h) via `pickMostRecentlyCompletedClaim()`, formats a wider candidate
   list within `PRE_CALL_CANDIDATE_WINDOW_HOURS` (12h, capped at
   `PRE_CALL_CANDIDATE_LIMIT` = 15) via `formatClaimsCandidates()`.
2. Wraps the result as `{ initial_context: {...} }`, Dograh's expected shape.
3. Try/catches the whole thing so a Sheet-read failure degrades to
   `{ initial_context: { has_claim_suggestion: false } }` instead of failing
   the call — Dograh's Pre-Call Data Fetch contract is "proceed without the
   extra context on any failure."

`routeWebhook()` dispatches `event=dograh_pre_call` to it directly, before
the `CallSessionId`/`From` parsing every other event goes through — there is
no call session yet at this point, same reason `retell_inbound` needs the
same early placement.

### Change 1 — Extract the shared builder

New function `buildClaimSuggestionContext()` holds exactly what
`handleDograhPreCall()`'s try block built (item 1 above), unchanged in
substance, with one deliberate addition: it always returns every
`suggested_*` key, defaulted to `''` when there's no suggestion, instead of
omitting them. This is what makes the empty-string-defaults requirement
(see "Change 3" below) correct for both platforms from one code path,
instead of Retell's wrapper having to invent defaults for keys the shared
builder might not even produce.

```js
function buildClaimSuggestionContext() {
  var now = new Date()
  var claims = getCachedClaims()
  var suggestion = pickMostRecentlyCompletedClaim(claims, now)
  var candidatesText = formatClaimsCandidates(claims, now)

  return {
    has_claim_suggestion: Boolean(suggestion),
    suggested_insured_last_name: (suggestion && suggestion.insured_last_name) || '',
    suggested_address_line1: (suggestion && suggestion.address_line1) || '',
    suggested_city: (suggestion && suggestion.city) || '',
    suggested_claim_number: (suggestion && suggestion.claim_number) || '',
    claims_candidates_text: candidatesText,
  }
}
```

It does **not** catch errors itself — that stays each platform handler's own
responsibility, because the two platforms already have (and keep) different
failure-log event names (`dograh_pre_call.failed` vs. `retell_inbound.failed`),
and the existing Dograh test suite asserts on the former. A shared
`EMPTY_CLAIM_SUGGESTION_CONTEXT` constant (all keys defaulted) is what both
handlers' catch blocks fall back to.

`handleDograhPreCall()` becomes a thin wrapper:

```js
function handleDograhPreCall() {
  try {
    var initialContext = buildClaimSuggestionContext()
    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: initialContext }),
    ).setMimeType(ContentService.MimeType.JSON)
  } catch (err) {
    var described = describeError(err)
    logEvent('dograh_pre_call.failed', { error: described.error, stack: described.stack })
    return ContentService.createTextOutput(
      JSON.stringify({ initial_context: EMPTY_CLAIM_SUGGESTION_CONTEXT }),
    ).setMimeType(ContentService.MimeType.JSON)
  }
}
```

**Minor, deliberate behavior change to Dograh's existing output:** today, the
no-suggestion and error paths omit `suggested_*` keys entirely; after this
change they're present as `''`. This is additive only (no key removed, no
type changed) and is the same fix the task requires for Retell — see Change 3. Flagging per `.claude/CLAUDE.md`'s guidance on backwards-incompatible
changes: this is **not** expected to be breaking (Dograh's own Notetaker
workflow template substitution has not been observed to choke on an extra
key), but it does change the wire shape Dograh receives, so it's called out
explicitly rather than left implicit in a diff.

### Change 2 — `event=retell_inbound` route

Retell's inbound webhook (confirmed against Retell's docs,
`docs.retellai.com/features/inbound-call-webhook`, fetched during this
spec's research) POSTs a JSON body shaped
`{ event: "call_inbound", call_inbound: { agent_id, from_number, to_number } }`
— structurally identical to what Dograh's Pre-Call Data Fetch already sends
(see the `dograh_pre_call` test fixture in `webhook.test.ts`, which posts
the exact same `call_inbound` envelope). It expects a response shaped:

```json
{
  "call_inbound": {
    "dynamic_variables": { "...": "..." }
  }
}
```

(Retell's full schema also supports `reject`, `override_agent_id`,
`override_agent_version`, `agent_override` — all out of scope here per
Non-goals.)

New branch in `routeWebhook()`, placed immediately after the existing
`dograh_pre_call` block (same reasoning: no `CallSessionId` exists yet):

```js
if (event === 'retell_inbound') {
  var retellBody = parseJsonBody(e)
  var retellFromNumber = (retellBody.call_inbound && retellBody.call_inbound.from_number) || ''
  return accepted('retell_inbound:' + retellFromNumber, handleRetellInbound())
}
```

```js
function handleRetellInbound() {
  try {
    var initialContext = buildClaimSuggestionContext()
    return ContentService.createTextOutput(
      JSON.stringify({
        call_inbound: { dynamic_variables: toRetellDynamicVariables(initialContext) },
      }),
    ).setMimeType(ContentService.MimeType.JSON)
  } catch (err) {
    var described = describeError(err)
    logEvent('retell_inbound.failed', { error: described.error, stack: described.stack })
    return ContentService.createTextOutput(
      JSON.stringify({
        call_inbound: {
          dynamic_variables: toRetellDynamicVariables(EMPTY_CLAIM_SUGGESTION_CONTEXT),
        },
      }),
    ).setMimeType(ContentService.MimeType.JSON)
  }
}
```

### Change 3 — Retell's string-only `dynamic_variables` + empty-string defaults

Confirmed against Retell's dynamic-variables docs
(`docs.retellai.com/build/dynamic-variables`, fetched during this spec's
research):

- **All values in `dynamic_variables` must be strings.** Booleans/numbers
  are rejected outright — `has_claim_suggestion` (a real boolean in
  `buildClaimSuggestionContext()`'s return value, matching Dograh's existing
  `initial_context` shape) has to be stringified for Retell specifically.
- **A variable referenced in the agent's prompt that is missing from
  `dynamic_variables` is spoken literally**, curly braces and all (e.g. the
  agent would say "suggested insured last name is
  suggested*insured_last_name"). An explicit empty string is treated as a
  valid value and substitutes to nothing — this is exactly the case
  `buildClaimSuggestionContext()`'s always-present `suggested*\*` keys exist
  to guarantee.

```js
// Retell requires every dynamic_variables value to be a string; a key that's
// simply absent leaves the {{template}} placeholder spoken literally by the
// agent (confirmed against Retell's dynamic-variables docs). has_claim_
// suggestion is the one key buildClaimSuggestionContext() returns as a real
// boolean (Dograh's initial_context has always taken it as one) — this is
// the only place that needs converting.
function toRetellDynamicVariables(context) {
  var out = {}
  Object.keys(context).forEach(function (key) {
    var value = context[key]
    out[key] = typeof value === 'boolean' ? String(value) : value || ''
  })
  return out
}
```

Because `buildClaimSuggestionContext()` already guarantees every
`suggested_*` key is present (Change 1), `toRetellDynamicVariables()` never
has to invent a default for a missing key — it only has to convert types.

### Change 4 — Timeout budget vs. measured latency, and why caching is in scope

**Retell's budget (confirmed via Retell's docs,
`docs.retellai.com/features/inbound-call-webhook`, fetched during this
spec's research):** the webhook POSTs with a **10-second timeout**; on a
non-2xx or no response it **retries up to 3 times**, then falls back to the
number's default agent if one is configured, else disconnects the call.

**Measured baseline (empirical, this session):** the reachability probe
(`doGet`, no Sheet access, no shared-secret required) was curled three times
against the live production endpoint,
`https://www.bh-systems.com/texml/gas`:

| Attempt | `time_total` |
| ------- | ------------ |
| 1       | 2.14s        |
| 2       | 2.81s        |
| 3       | 3.19s        |

This is Worker-proxy-hop + Apps Script response time with **zero** Sheet
work — `doGet()` returns a static string. It's a warm-path floor, not a
worst case: it doesn't capture a genuine cold start (the deployment had
presumably already been hit recently), and `buildClaimSuggestionContext()`
adds a real `getClaims()` Sheet read (`SpreadsheetApp.openById()` +
`getDataRange().getValues()` on the Claims tab) on top, which this session
could not measure directly without the production shared secret.

**Estimate:** treating 2-3s as the warm floor and adding a conservative
200-800ms for an unindexed Sheet read (no lock is taken on this read path —
`getClaims()` doesn't call `withJobLock`) puts a warm `retell_inbound`
response around **2.5-4s**. Apps Script cold starts are documented (Google's
own guidance and community reports) as commonly adding low-single-digit
seconds beyond a warm response, which could push a genuinely cold request
into the **5-8s** range — still under the 10s per-attempt budget, but
consuming most of it, with no margin against a slow day (Sheets API
backpressure, a large Claims tab, a coincident calendar-sync tick).

**Decision: add `CacheService` caching now**, not as a reactive fix after a
timeout is observed in production. Rationale: the measured warm floor
already eats 20-30% of the budget before any Sheet work; the estimate's
cold-path tail has real (if unconfirmed) risk of eating most of the rest;
the fix is cheap (Apps Script's `CacheService` is already available, no new
dependency); and it's explicitly called for in this spec's brief.
Post-call matching (`runner.js`'s two `getClaims()` calls) is **deliberately
excluded** from this cache — that path determines the claim a job is
permanently filed under, so it stays on a live Sheet read; only the
pre-call suggestion, which is advisory and re-computed fresh on the actual
matching pass after the call, is cached.

New in `apps/adjuster/src/jobs.js` (co-located with `getClaims()`, the
Sheet-access layer both `webhook.js` and `calendarSync.js` already call
into):

```js
var CLAIM_CANDIDATES_CACHE_KEY = 'claim_candidates_v1'
var CLAIM_CANDIDATES_CACHE_TTL_SECONDS = 21600 // CacheService's own max: 6h

function refreshClaimCandidatesCache() {
  var claims = getClaims()
  CacheService.getScriptCache().put(
    CLAIM_CANDIDATES_CACHE_KEY,
    JSON.stringify(claims),
    CLAIM_CANDIDATES_CACHE_TTL_SECONDS,
  )
  return claims
}

// Read-through: a hit skips the Sheet read entirely. A miss (nothing has
// synced in the last 6h — CacheService's own max TTL — or this is the first
// call since a fresh deploy) falls back to a live read and repopulates the
// cache, so this is always correct, just slower on a miss than getClaims()
// itself would be.
function getCachedClaims() {
  var cached = CacheService.getScriptCache().get(CLAIM_CANDIDATES_CACHE_KEY)
  if (cached) {
    try {
      return JSON.parse(cached)
    } catch (err) {
      // Fall through to a live read below.
    }
  }
  return refreshClaimCandidatesCache()
}
```

`calendarSync.js`'s `syncClaimsFromCalendar()` calls
`refreshClaimCandidatesCache()` once per tick (it already runs hourly via
the installed trigger — see `installCalendarSync()`), right before the
`tick_end` log line, wrapped in its own try/catch so a `CacheService`
hiccup degrades the same way every other best-effort piece of this tick
already does (property lookup, per-event failures) rather than failing the
whole sync:

```js
try {
  refreshClaimCandidatesCache()
} catch (err) {
  logEvent('calendar_sync.cache_refresh_failed', { error: String(err) })
}
```

`buildClaimSuggestionContext()` (Change 1) calls `getCachedClaims()` instead
of `getClaims()` directly — this is the only call site that changes.

## Implementation Phases

### Phase 1 — Extract `buildClaimSuggestionContext()`

- Add `buildClaimSuggestionContext()` and `EMPTY_CLAIM_SUGGESTION_CONTEXT` to
  `webhook.js`; refactor `handleDograhPreCall()` to use them (Change 1).
- Update `webhook.test.ts`'s existing "Dograh Pre-Call Data Fetch" describe
  block only as needed to account for the always-present `suggested_*`
  keys — existing assertions (`has_claim_suggestion`,
  `suggested_insured_last_name`, `suggested_address_line1`, candidate
  ordering, the `dograh_pre_call.failed` log event) must keep passing
  unchanged.
- Unit tests: builder output for suggestion-found, no-suggestion, and
  Sheet-read-failure (via `getClaims`/`getCachedClaims` throwing) cases —
  covers the task's required "builder output" test matrix directly.

### Phase 2 — `event=retell_inbound` route

- Add the `retell_inbound` branch to `routeWebhook()`, `handleRetellInbound()`,
  and `toRetellDynamicVariables()` to `webhook.js` (Change 2, Change 3).
- Unit tests in `webhook.test.ts` (new "Retell Inbound Call Webhook" describe
  block, mirroring the existing Dograh Pre-Call one):
  - suggestion-found case: `call_inbound.dynamic_variables.has_claim_suggestion`
    is the string `'true'`, `suggested_*` values are the string field values.
  - no-suggestion case: `has_claim_suggestion` is `'false'`, every
    `suggested_*` key is present and `''` (never absent, never `undefined`).
  - error-path case: `getClaims`/`getCachedClaims` throws → response still
    has every `dynamic_variables` key as a string default, and
    `retell_inbound.failed` is logged (not `dograh_pre_call.failed`).
  - the shared-secret gate (`t` param) and early placement (no
    `CallSessionId` required) apply to `retell_inbound` the same as
    `dograh_pre_call`.

### Phase 3 — `CacheService` caching

- Add `CLAIM_CANDIDATES_CACHE_KEY`, `refreshClaimCandidatesCache()`,
  `getCachedClaims()` to `jobs.js`; wire `buildClaimSuggestionContext()` to
  call `getCachedClaims()` (Change 4).
- Wire `syncClaimsFromCalendar()` in `calendarSync.js` to call
  `refreshClaimCandidatesCache()` once per tick, guarded by its own
  try/catch.
- Add `CacheService` (`getScriptCache().get`/`.put`) to both test harnesses'
  mocked globals (`webhook.test.ts`, `calendarSync.test.ts`), following the
  same pattern as the existing `DriveApp`/`UrlFetchApp` mocks.
- Unit tests:
  - `getCachedClaims()` returns the cached value and never calls the
    underlying `getClaims()` on a cache hit.
  - `getCachedClaims()` falls back to a live `getClaims()` read and
    repopulates the cache on a miss (empty cache) and on a corrupt cache
    entry (non-JSON string).
  - `syncClaimsFromCalendar()` calls `refreshClaimCandidatesCache()` once
    per tick and a cache-write failure doesn't fail the tick or skip
    `tick_end` logging.

## Edge Cases & Risk

| Risk                                                                                                                                                                        | Likelihood    | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache never refreshed (calendar sync trigger deleted/failing) — `getCachedClaims()` serves stale data for up to 6h, then falls back to live                                 | L             | M      | `refreshClaimCandidatesCache()`'s own failure is logged (`calendar_sync.cache_refresh_failed`); CacheService's 6h max TTL bounds the staleness window even in total silence                                                                                                                                                                                                   |
| Claims sheet grows large enough that the cached JSON blob approaches CacheService's 100KB per-key limit                                                                     | L             | M      | Not hit at current scale (Claims tab is a rolling window of recent appointments, not permanent history); flagged here as a future risk, not solved by this spec — `put()` throwing on an oversized value is caught by `refreshClaimCandidatesCache`'s own try/catch at the call site in `calendarSync.js`, degrading to "no cache refresh this tick" rather than failing sync |
| Retell retries the same inbound webhook up to 3x on a slow/failed first attempt                                                                                             | M             | L      | `buildClaimSuggestionContext()` and `getCachedClaims()` are read-only and idempotent — concurrent/repeated calls are safe with no locking needed                                                                                                                                                                                                                              |
| A cold Apps Script start plus a cache miss (first request after a >6h gap) both land on the same call                                                                       | L             | M      | Worst case is a live `getClaims()` read — the exact latency profile that exists today for Dograh; not a regression, just the cache's floor                                                                                                                                                                                                                                    |
| Dograh's own template substitution behaves differently than Retell's on a missing/extra key (unconfirmed for Dograh, since its docs don't specify this the way Retell's do) | L             | L      | `buildClaimSuggestionContext()`'s change is additive only (extra empty-string keys, nothing removed/retyped) — a template engine that ignores unused keys is unaffected either way                                                                                                                                                                                            |
| `event=retell_inbound` reachable without ever being wired to a real Retell agent (until spec 014 / dashboard config lands)                                                  | H (by design) | None   | No live traffic hits this route until Retell's dashboard is pointed at it — same "reachable but unused until wired up" state `guided_start`/`guided`/etc. are already in today                                                                                                                                                                                                |

## Acceptance Criteria

- [ ] `buildClaimSuggestionContext()` extracted in `apps/adjuster/src/webhook.js`;
      `handleDograhPreCall()` uses it and produces the same
      `{ initial_context }` shape as today (plus always-present, empty-string
      `suggested_*` keys on the no-suggestion/error paths)
- [ ] `event=retell_inbound` routes to `handleRetellInbound()`, gated by the
      same `?t=` shared secret, placed before `CallSessionId` parsing
- [ ] `handleRetellInbound()` returns `{ call_inbound: { dynamic_variables } }`
      with every value a string, matching Retell's documented response shape
- [ ] Every `dynamic_variables` key `buildClaimSuggestionContext()` can
      produce is always present (never omitted) so no `{{template}}`
      placeholder is ever left unfilled for Retell to speak literally
- [ ] `getCachedClaims()`/`refreshClaimCandidatesCache()` added to `jobs.js`;
      `buildClaimSuggestionContext()` reads through the cache;
      `syncClaimsFromCalendar()` refreshes it once per tick
- [ ] Unit tests cover: builder output for suggestion-found, no-suggestion,
      and Sheet-read-failure cases; Retell route for the same three cases;
      cache hit/miss/corrupt-entry behavior; sync-tick cache refresh and its
      own failure isolation
- [ ] `pnpm typecheck`, `pnpm vitest run tests/unit/adjuster/webhook.test.ts
tests/unit/adjuster/calendarSync.test.ts`, `pnpm format`, `pnpm lint`
      all pass
- [ ] No hardcoded secrets; no change to `WEBHOOK_SECRET`/auth scheme
- [ ] Existing Dograh Pre-Call and calendar-sync tests continue to pass
      unchanged in substance (aside from the additive empty-string-key
      assertions noted above)
