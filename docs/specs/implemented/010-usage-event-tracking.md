# Usage Event Tracking

**Status:** Implemented — completed 2026-06-01
**Owner:** Barton Holdridge
**Last updated:** 2026-06-01

## Objective

Record a row in a `usage_events` table each time a user triggers a generation — specifically when `resume-parse` and `submittal-fit` edge functions complete successfully. This gives us per-user call counts and a timestamped audit trail, which is a prerequisite for usage-based billing, quota enforcement, and any future generation-history feature.

## Non-goals

- Frontend display of usage counts or history
- Analytics dashboard or admin reporting UI
- Storing generation inputs or outputs (that is spec-011 territory)
- Per-token or cost tracking
- Quota enforcement or rate limiting (this spec only records; it does not gate)
- Tracking any function other than `resume-parse` and `submittal-fit`

## Business Rationale

We have no visibility into how often users generate submittals. Without it we cannot reason about usage-based pricing tiers, detect abuse, or build a generation-history feature. This is the minimal, lowest-risk foundation: a single append-only table populated by two existing functions.

## Architecture

### Schema / Migration

New table `public.usage_events`:

| Column       | Type                                  | Notes                                |
| ------------ | ------------------------------------- | ------------------------------------ |
| `id`         | `uuid` PK default gen                 | Surrogate key                        |
| `user_id`    | `uuid` NOT NULL FK → `auth.users(id)` | The authenticated caller             |
| `event_type` | `text` NOT NULL`                      | e.g. `resume_parse`, `submittal_fit` |
| `created_at` | `timestamptz` default now()           | Insertion timestamp, no TZ ambiguity |

Index on `(user_id, created_at DESC)` for per-user count/list queries.

**RLS:**

- `SELECT`: `auth.uid() = user_id` — users can read only their own rows.
- `INSERT`: denied for authenticated/anon roles; inserts go through the service-role client inside the edge functions, bypassing RLS. This keeps the write path simple and prevents clients from spoofing event rows.

No `UPDATE` or `DELETE` policies — the table is append-only.

### Edge Function Changes

Both functions already receive `userId` from `withAuth`. After the primary AI call succeeds and before returning the 200 response, each function will:

1. Initialise a Supabase admin client using `loadSupabaseAdminEnv()` (service role key — already available via the shared `_shared/env.ts` loader, no new env vars needed).
2. Call `supabase.from('usage_events').insert({ user_id: userId, event_type: '<name>' })`.
3. **Fire-and-forget with a logged warning on failure** — a tracking write failure must never cause the generation response to fail. Wrap in a `try/catch`, log the error with the child logger at `warn` level, and continue.

`event_type` values (string constants, not an enum, to stay schema-migration-free for future additions):

- `resume_parse` — emitted by `resume-parse`
- `submittal_fit` — emitted by `submittal-fit`

### Auth Model

Writes use the **service role client** (`SUPABASE_SERVICE_ROLE_KEY`) so they bypass RLS. The `user_id` value comes from the already-validated `withAuth` middleware, so there is no spoofing risk. Reads are gated by RLS (`auth.uid() = user_id`).

### Shared Package Impact

None. Changes are confined to two edge functions and one migration.

### ADR

No new architectural decision warranting a separate ADR — the pattern (service-role insert inside a withAuth function) is already established in this codebase.

## Implementation Phases

### Phase 1 — Migration

- Add migration `YYYYMMDDHHMMSS_usage_events.sql` under `supabase/migrations/`.
- Create `public.usage_events` table with columns, index, and RLS policies as specified above.
- Enable RLS on the table.

### Phase 2 — Edge Function Instrumentation

- In `resume-parse/index.ts`: after a successful parse response is assembled, fire-and-forget insert with `event_type: 'resume_parse'`.
- In `submittal-fit/index.ts`: after a successful fit response is assembled, fire-and-forget insert with `event_type: 'submittal_fit'`.
- Extract a shared helper `_shared/track-usage.ts` that accepts `(userId: string, eventType: string, log: Logger)` and encapsulates the admin-client init, insert, and error handling. Both functions import from here.
- The helper must not throw — all errors are caught and logged at `warn`.

### Phase 3 — Tests

- Unit test for `_shared/track-usage.ts`: stub the Supabase client, assert insert is called with correct args; assert no throw on client error.
- Unit tests for both edge function handlers: assert the tracking helper is called after a successful generation; assert the 200 response is still returned even if the tracking helper throws.

## Edge Cases & Risk

| Risk                                             | Likelihood                              | Impact                | Mitigation                                                                 |
| ------------------------------------------------ | --------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| Tracking write fails, breaks generation response | M (DB hiccup)                           | H (user-facing error) | Fire-and-forget; errors logged, not rethrown                               |
| Service role key missing in env                  | L (already required by other functions) | M (silent no-track)   | `requireEnv` will surface at cold-start, not silently                      |
| Double-counting if client retries on timeout     | L                                       | L                     | Acceptable at this stage; not enforcing quotas yet                         |
| RLS misconfiguration lets users insert directly  | L                                       | M                     | INSERT policy is absent for authed/anon roles; only service role can write |

## Acceptance Criteria

- [ ] Migration creates `public.usage_events` with correct columns, index, and RLS
- [ ] RLS: authenticated users can SELECT only their own rows; INSERT via anon/authed role is rejected
- [ ] `resume-parse` inserts a `resume_parse` event row on successful completion
- [ ] `submittal-fit` inserts a `submittal_fit` event row on successful completion
- [ ] A tracking insert failure does NOT cause the edge function to return a non-2xx response
- [ ] Shared helper `_shared/track-usage.ts` extracted and used by both functions
- [ ] Unit tests for the helper and both function handlers pass
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` all pass
- [ ] No hardcoded secrets; service role key loaded via `loadSupabaseAdminEnv()`
