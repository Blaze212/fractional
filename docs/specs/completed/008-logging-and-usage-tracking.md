# Production Logging & Usage Tracking

**Status:** Implemented — PR #5
**Owner:** Barton Holdridge
**Last updated:** 2026-06-01

## Objective

Add two cross-cutting capabilities to the fractional project's edge functions:
(1) structured, production-grade logging at every meaningful decision point in
`resume-parse` and `submittal-fit` so failures can be diagnosed from logs alone,
and (2) per-user usage quota tracking plus per-LLM-call telemetry (token counts,
latency, success/error) stored in Postgres, mirroring the `usage_limits` and
`ai_usage_log` patterns already established in the main CareerSystems app.

## Non-goals

- **Quota enforcement** — `usage_limits` is write-only for now; no gate logic
  blocks requests when a limit is exceeded (that is a future spec).
- **Billing / cost rollup** — token counts are stored but no cost calculation
  is added.
- **Frontend usage dashboard** — no UI changes in this spec.
- **Distributed tracing / OpenTelemetry** — structured JSON logs only; no trace
  IDs or spans.
- **Retry / backoff logging** — the existing auto-regeneration path in
  `submittal-fit` is already logged at `warn`; no changes to retry logic itself.

## Business Rationale

Production incidents are currently hard to diagnose because log coverage is
sparse and token costs are invisible. Structured logs enable Supabase log
queries and alerting. Token tracking enables cost attribution per user and
feature, and the `usage_limits` table gives a foundation for future quota
enforcement without a schema migration later.

## Architecture

### Schema changes

Two new tables and one new constraint:

| Object                                     | Type       | Purpose                                                |
| ------------------------------------------ | ---------- | ------------------------------------------------------ |
| `public.usage_limits`                      | table      | Per-user, per-tool quota counters with weekly rollover |
| `public.ai_usage_log`                      | table      | One row per LLM API call                               |
| `unique (user_id, tool)` on `usage_limits` | constraint | Enables upsert                                         |

`usage_events` (added in the previous migration) is unchanged in schema but
`track-usage.ts` will additionally upsert `usage_limits` on each call.

### Edge Function changes

| File                             | Change                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- |
| `_shared/ai-client.ts`           | `completeJson()` returns `latencyMs`; `TokenUsage` type gains `latencyMs` |
| `_shared/log-ai-usage.ts`        | **new** — `logAiUsage()` fire-and-forget helper                           |
| `_shared/track-usage.ts`         | Extend to upsert `usage_limits` in addition to `usage_events`             |
| `resume-parse/resume-parse.ts`   | Add structured log statements + `logAiUsage` call                         |
| `submittal-fit/submittal-fit.ts` | Add structured log statements + `logAiUsage` calls; accept `UsageContext` |
| `submittal-fit/fit-grader.ts`    | Add per-layer timing + `logAiUsage` call                                  |
| `submittal-fit/index.ts`         | Pass `UsageContext` down; log overall request timing                      |
| `resume-parse/index.ts`          | Pass `UsageContext` down; log overall request timing                      |

### Auth model

All new Supabase writes use the service-role key (via `loadSupabaseAdminEnv()`),
consistent with the existing `track-usage.ts` pattern. RLS policies block user
reads to their own rows only.

### New env vars

None. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already loaded by
`loadSupabaseAdminEnv()`.

### Shared package impact

None — changes are confined to `supabase/functions/`.

### ADR

No new architectural decision; this follows the pattern already established in
`usage_events` / `track-usage.ts`.

---

## Implementation Phases

### Phase 1 — Migrations

Two new migrations (sequential timestamps, one file each):

#### `usage_limits`

```sql
create table public.usage_limits (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id),
  tool           text        not null,
  usage_count    int         not null default 0,
  override_limit int         null,
  period_start   timestamptz not null default now(),
  lifetime_count bigint      not null default 0,
  unique (user_id, tool)
);

create index usage_limits_user_id_tool_idx
  on public.usage_limits (user_id, tool);

alter table public.usage_limits enable row level security;

create policy "users_select_own"
  on public.usage_limits
  for select
  using (auth.uid() = user_id);
```

#### `ai_usage_log`

```sql
create table public.ai_usage_log (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id),
  session_id    text        null,
  feature       text        not null,
  provider      text        not null,
  model         text        not null,
  input_tokens  int         not null default 0,
  output_tokens int         not null default 0,
  total_tokens  int         not null generated always as (input_tokens + output_tokens) stored,
  latency_ms    int         not null default 0,
  success       boolean     not null default true,
  error_code    text        null,
  created_at    timestamptz not null default now()
);

create index ai_usage_log_user_id_created_at_idx
  on public.ai_usage_log (user_id, created_at desc);

alter table public.ai_usage_log enable row level security;

create policy "users_select_own"
  on public.ai_usage_log
  for select
  using (auth.uid() = user_id);
```

**Tests required:** None beyond the migration applying cleanly. RLS
behaviour is verified in unit tests for the helpers (Phase 2).

---

### Phase 2 — `ai-client.ts` + new `log-ai-usage.ts` helper

#### `TokenUsage` type update

```ts
export type TokenUsage = {
  input: number
  output: number
  model?: string
  latencyMs: number // ← new
}
```

`completeJson()` records `performance.now()` before the `responses.create` call
and computes `latencyMs = Math.round(end - start)` after. The value is included
in the returned `TokenUsage` object and in the existing debug log line.

#### `_shared/log-ai-usage.ts`

```ts
export interface AiUsageParams {
  supabaseUrl: string
  serviceKey: string
  userId: string
  sessionId?: string
  feature: string
  tokens: TokenUsage // input, output, model, latencyMs
  success: boolean
  errorCode?: string
}

export async function logAiUsage(params: AiUsageParams, log: LoggerLike): Promise<void>
```

- Creates a one-off Supabase client with the service role key.
- Inserts one row into `ai_usage_log`.
- On error: `log.warn(...)` and return — never throws.
- `provider` is hardcoded `'openai'` for now.
- `session_id` is passed as `null` when not provided.

**Tests required:**

- Happy path inserts correct row shape.
- Supabase error → warn log, no throw.
- `latencyMs` forwarded correctly from `TokenUsage`.

---

### Phase 3 — `track-usage.ts` extension

After the existing `usage_events` insert, upsert into `usage_limits`:

```sql
INSERT INTO usage_limits (user_id, tool, usage_count, period_start, lifetime_count)
VALUES ($userId, $tool, 1, now(), 1)
ON CONFLICT (user_id, tool) DO UPDATE SET
  usage_count    = CASE
                     WHEN usage_limits.period_start + interval '7 days' <= now()
                     THEN 1
                     ELSE usage_limits.usage_count + 1
                   END,
  period_start   = CASE
                     WHEN usage_limits.period_start + interval '7 days' <= now()
                     THEN now()
                     ELSE usage_limits.period_start
                   END,
  lifetime_count = usage_limits.lifetime_count + 1
```

- The `tool` value is the `eventType` string already passed to `trackUsageEvent`
  (e.g. `'resume_parse'`, `'submittal_fit'`).
- On upsert error: `log.warn(...)` and return — never throws.

**Tests required:**

- First call creates row with `usage_count=1`, `lifetime_count=1`.
- Second call within period: `usage_count=2`, `lifetime_count=2`.
- Call after period expiry: `usage_count` resets to 1, `lifetime_count` increments,
  `period_start` updates.
- Supabase error on upsert → warn, no throw.

---

### Phase 4 — Production Logging

Add structured `log.*` calls at every decision point. Pattern throughout:
`log.info({ field1, field2 }, 'module: message')` — no interpolated strings.

#### `resume-parse/resume-parse.ts` — `runParsing()`

| Point             | Level   | Fields                                                 |
| ----------------- | ------- | ------------------------------------------------------ |
| Function entry    | `info`  | `input_char_count`                                     |
| Prompt built      | `debug` | `prompt_char_count`                                    |
| LLM call start    | `debug` | `model`, `schema_name`                                 |
| LLM call complete | `info`  | `model`, `input_tokens`, `output_tokens`, `latency_ms` |
| LLM error         | `error` | `err` (full Error object), `model`                     |

#### `submittal-fit/submittal-fit.ts` — `callGenerator()`

| Point                 | Level   | Fields                                                            |
| --------------------- | ------- | ----------------------------------------------------------------- |
| Call start            | `info`  | `client`, `role`, `jd_char_count`, `attempt` (1/2/3)              |
| LLM call complete     | `info`  | `model`, `input_tokens`, `output_tokens`, `latency_ms`, `attempt` |
| Shape validation fail | `error` | `reason`, `attempt`                                               |
| LLM error             | `error` | `err`, `model`, `attempt`                                         |

`runFitGeneration()`:

| Point                  | Level  | Fields                                                              |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| Hallucination detected | `warn` | `issues`, `attempt` (already present, verify fields are structured) |
| Auto-regen failed      | `warn` | `err`, `attempt`                                                    |
| Final grade            | `info` | `grade_action`, `failure_class`, `issue_count`, `warning_count`     |
| Total token summary    | `info` | `total_input_tokens`, `total_output_tokens`, `call_count`           |

#### `submittal-fit/fit-grader.ts` — `gradeFit()`

| Point                | Level   | Fields                                                                       |
| -------------------- | ------- | ---------------------------------------------------------------------------- |
| Layer 0 start        | `debug` | —                                                                            |
| Layer 0 result       | `debug` | `banned_phrase_issues`, `coverage_issues`                                    |
| Layer 1 start (LLM)  | `debug` | `model`, `schema_name`                                                       |
| Layer 1 complete     | `info`  | `model`, `input_tokens`, `output_tokens`, `latency_ms`, `hallucination_flag` |
| Layer 2 start (LLM)  | `debug` | `model`, `schema_name`                                                       |
| Layer 2 complete     | `info`  | `model`, `input_tokens`, `output_tokens`, `latency_ms`, `gap_count`          |
| Final grade decision | `info`  | `action`, `failure_class`, `issue_count`, `warning_count`                    |
| LLM error any layer  | `error` | `err`, `layer`, `model`                                                      |

#### `resume-parse/index.ts` and `submittal-fit/index.ts`

| Point              | Level  | Fields                                                  |
| ------------------ | ------ | ------------------------------------------------------- |
| Request received   | `info` | `method`, `content_length` (if available)               |
| Validation failure | `warn` | already present — verify `code` field is structured     |
| Handler complete   | `info` | `status`, `elapsed_ms` (from request entry to response) |

**Tests required:**

- For each domain function, assert that log spy receives calls with the correct
  fields and level when a mocked `AiClient` returns a fixture response or throws.
  Use `vitest` spies on the `LoggerLike` passed in.

---

### Phase 5 — Wire `UsageContext` and `logAiUsage` into domain functions

#### New shared type (in `_shared/log-ai-usage.ts` or `_shared/types.ts`)

```ts
export interface UsageContext {
  userId: string
  supabaseUrl: string
  serviceKey: string
}
```

#### `runParsing()` signature change

```ts
// before
export async function runParsing(
  resumeText: string,
  deps: Deps,
  log: LoggerLike,
): Promise<{ profile: ParsedProfile; meta: { model: string; input_char_count: number } }>

// after
export async function runParsing(
  resumeText: string,
  deps: Deps,
  log: LoggerLike,
  usageCtx: UsageContext, // ← new, required
): Promise<{ profile: ParsedProfile; meta: { model: string; input_char_count: number } }>
```

`runParsing` calls `logAiUsage` (fire-and-forget `void`) after the LLM call
succeeds or fails.

#### `runFitGeneration()` + `callGenerator()` signature change

```ts
// callGenerator gains usageCtx; calls logAiUsage internally for each attempt
async function callGenerator(
  input: SubmittalInput,
  aiClient: AiClient,
  log: LoggerLike,
  usageCtx: UsageContext,
): Promise<{ result: FitResult; model: string }>

// runFitGeneration gains usageCtx; passes it to callGenerator and gradeFit
export async function runFitGeneration(
  input: SubmittalInput,
  deps: Deps,
  log: LoggerLike,
  usageCtx: UsageContext,
): Promise<{ result: FitResult; grade: FitGrade; meta: { model: string } }>
```

#### `gradeFit()` signature change

```ts
export async function gradeFit(
  input: SubmittalInput,
  result: FitResult,
  deps: GraderDeps,
  log: LoggerLike,
  usageCtx: UsageContext, // ← new
): Promise<FitGrade>
```

Calls `logAiUsage` with `feature='submittal-fit-grader'` for each LLM grader call.

#### Index function changes

Both `index.ts` handlers already have `userId`. They call `loadSupabaseAdminEnv()`
to get `supabaseUrl` and `serviceKey`, build a `UsageContext`, and pass it to
the domain function.

**Tests required:**

- `runParsing`: with a mocked `logAiUsage`, assert it is called with correct
  feature, token counts, and `success=true` on the happy path; `success=false`
  with `errorCode` on LLM throw.
- `callGenerator`: same for `feature='submittal-fit'`.
- `gradeFit`: same for `feature='submittal-fit-grader'`.
- Integration: index handler unit test asserts `UsageContext` is constructed
  from env and passed through (mock `runFitGeneration` / `runParsing`).

---

## Edge Cases & Risk

| Risk                                                      | Likelihood | Impact | Mitigation                                                                        |
| --------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------- |
| `logAiUsage` insert fails (network / RLS)                 | M          | L      | Fire-and-forget with `log.warn`; never throws                                     |
| `usage_limits` upsert race (concurrent requests)          | L          | L      | Postgres atomic ON CONFLICT; worst case count is slightly off                     |
| `latencyMs` overflow (very slow calls)                    | L          | L      | `Math.round()` to int; Postgres `int` holds up to ~2.1B ms                        |
| `total_tokens` generated column breaks on older Supabase  | L          | M      | Generated columns are standard Postgres 12+; Supabase uses Postgres 15            |
| `UsageContext` threaded to many call sites — easy to miss | M          | M      | TypeScript makes it a required param; tsc catches omissions                       |
| Logging PII in structured fields                          | M          | H      | Fields are: char counts, token counts, model names, error codes — no user content |

---

## Acceptance Criteria

- [ ] Migration `usage_limits`: table created, unique constraint, RLS, index
- [ ] Migration `ai_usage_log`: table created, generated column, RLS, index
- [ ] `TokenUsage.latencyMs` added; `completeJson()` measures and returns it
- [ ] `logAiUsage()` helper: inserts correct row; swallows errors with `log.warn`
- [ ] `trackUsageEvent()` upserts `usage_limits` with weekly rollover logic
- [ ] `resume-parse` logs input char count, token counts, latency, errors
- [ ] `submittal-fit` logs per-attempt token counts, latency, final grade fields
- [ ] `fit-grader` logs per-layer timing, LLM token counts, grade decision
- [ ] Both index handlers log overall `elapsed_ms` and response status
- [ ] `UsageContext` threaded to `runParsing`, `runFitGeneration`, `callGenerator`, `gradeFit`
- [ ] `logAiUsage` called (fire-and-forget) on every LLM call in all three domain functions
- [ ] Unit tests cover: `logAiUsage` happy + error path, `trackUsageEvent` upsert + rollover, log spy assertions in domain functions
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass
- [ ] No hardcoded secrets; no user content in log fields
