# Spec 010 — OpenRouter AI Client Integration

## Status: Proposed

## Problem

All AI calls in CareerSystems edge functions are hardwired to OpenAI (Responses API).
Switching to a cheaper, faster, or different model requires code changes across multiple
files. There is no central place to configure which models to use — defaults are scattered
as `DEFAULT_MODEL` constants inside each function's `index.ts`. There is no way to A/B
test models, try new providers, or activate fallbacks without a deploy.

OpenRouter is a proxy that sits in front of 300+ models (OpenAI, Anthropic, Google,
Mistral, Meta, DeepSeek, etc.) behind a single OpenAI-compatible Chat Completions API.
Adding it as a selectable client, alongside centralising model config in `agencyConfig.ts`,
lets us swap models and providers with env var changes only.

---

## Goals

1. Centralise all model/provider config in `agencyConfig.ts` under the existing `llm` key.
2. Add `OpenAiChatClient` and `OpenRouterClient` classes implementing `AiClient`.
3. `OpenRouterClient` supports per-tier model fallback chains, configured in `agencyConfig.ts`.
4. Add a `makeAiClient(tier, log)` factory that reads `agencyConfig` + `AI_PROVIDER` env override.
5. Update `logAiUsage` to record provider dynamically (not hardcoded `'openai'`).
6. Zero pipeline-file changes — only `index.ts` files change.

---

## Non-goals

- Real-time smart routing decisions at request time.
- Per-request provider selection.
- Streaming responses (no current use case; all functions use `completeJson`).
- OpenRouter leaderboard headers (`X-Title`, `HTTP-Referer`) — optional vanity, no API impact.

---

## Background: OpenRouter API

OpenRouter exposes the OpenAI Chat Completions API at `https://openrouter.ai/api/v1`.
The `openai` npm package works as a drop-in client by setting `baseURL`:

```typescript
new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
```

**Important:** OpenRouter does **not** support the OpenAI Responses API
(`.responses.create()`). It only supports Chat Completions. The `OpenRouterClient`
will therefore use `chat.completions.create()` with `response_format: { type: 'json_schema' }`.

Model IDs use `org/model-name` format:

| CareerSystems tier | Native OpenAI ID | OpenRouter primary ID       |
| ------------------ | ---------------- | --------------------------- |
| `fast`             | `gpt-5.4-mini`   | `openai/gpt-5.4-mini`       |
| `quality`          | `gpt-5.4`        | `openai/gpt-5.4`            |
| `grader`           | `gpt-5.4`        | `anthropic/claude-opus-4-7` |
| `cheap`            | `gpt-5.4-mini`   | `google/gemini-2.5-flash`   |

**Fallbacks:** OpenRouter accepts a `models` array in the request body. It tries each
model in order on 5xx or rate-limit errors. The model actually used is returned in the
response and recorded in `ai_usage_log`.

---

## Config changes: `agencyConfig.ts`

Model config (currently scattered as `DEFAULT_MODEL` constants) moves into
`AGENCY_CONFIG.llm`. The factory reads from here; env vars can still override at deploy
time.

```typescript
export interface LlmTierConfig {
  /** Model ID for openai-responses and openai-chat providers */
  nativeModel: string
  /** Primary model ID for openrouter (org/model-name format) */
  openrouterModel: string
  /** Fallback chain tried in order on 5xx / rate-limit (openrouter only) */
  openrouterFallbacks: string[]
}

export interface AgencyEdgeConfig {
  identity: { name: string }
  llm: {
    fitNarrativeStyleGuide: string
    resumeParseNotes: string
    /** Default provider. Overridden at deploy time by AI_PROVIDER env var. */
    provider: 'openai-responses' | 'openai-chat' | 'openrouter'
    tiers: {
      fast: LlmTierConfig
      quality: LlmTierConfig
      grader: LlmTierConfig
      cheap: LlmTierConfig
    }
  }
}

export const AGENCY_CONFIG: AgencyEdgeConfig = {
  identity: { name: 'Agency Name' },
  llm: {
    fitNarrativeStyleGuide: FIT_NARRATIVE_STYLE_GUIDE,
    resumeParseNotes: '',
    provider: 'openai-responses',
    tiers: {
      fast: {
        nativeModel: 'gpt-5.4-mini',
        openrouterModel: 'openai/gpt-5.4-mini',
        openrouterFallbacks: ['google/gemini-2.5-flash'],
      },
      quality: {
        nativeModel: 'gpt-5.4',
        openrouterModel: 'openai/gpt-5.4',
        openrouterFallbacks: ['anthropic/claude-opus-4-7'],
      },
      grader: {
        nativeModel: 'gpt-5.4',
        openrouterModel: 'anthropic/claude-opus-4-7',
        openrouterFallbacks: ['openai/gpt-5.4'],
      },
      cheap: {
        nativeModel: 'gpt-5.4-mini',
        openrouterModel: 'google/gemini-2.5-flash',
        openrouterFallbacks: ['openai/gpt-5.4-mini'],
      },
    },
  },
}
```

---

## Architecture

### New: `OpenAiChatClient`

Chat Completions implementation of `AiClient` (already planned in `ai-provider-usage`
skill, not yet built). Shared base for `OpenRouterClient`.

```typescript
// _shared/ai-client.ts (addition)
export class OpenAiChatClient implements AiClient {
  protected client: OpenAI
  protected model: string
  readonly log: LoggerLike

  constructor(model: string, log: LoggerLike) {
    this.model = model
    this.log = log
    this.client = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })
  }

  async completeJson<T>(
    system,
    userPrompt,
    schemaName,
    schema,
  ): Promise<{ data: T; tokens: TokenUsage }> {
    // chat.completions.create() with
    // response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } }
    // parses choices[0].message.content
  }
}
```

### New: `OpenRouterClient`

Extends `OpenAiChatClient`. The only differences are the base URL, API key, and the
`models` fallback array injected into every request body.

```typescript
export class OpenRouterClient extends OpenAiChatClient {
  private fallbackModels: string[]

  constructor(model: string, fallbackModels: string[], log: LoggerLike) {
    super(model, log)
    this.fallbackModels = fallbackModels
    this.client = new OpenAI({
      apiKey: Deno.env.get('OPENROUTER_API_KEY'),
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }

  // completeJson passes body: { models: [this.model, ...this.fallbackModels], ... }
  // records the model actually used from response.model
}
```

### New: `makeAiClient()` factory (`_shared/ai-client-factory.ts`)

```typescript
import { AGENCY_CONFIG } from './agencyConfig.ts'
import type { AiClient } from './ai-client.ts'
import { OpenAiResponsesClient, OpenAiChatClient, OpenRouterClient } from './ai-client.ts'
import type { LoggerLike } from './logger.ts'

export type AiTier = 'fast' | 'quality' | 'grader' | 'cheap'

export function makeAiClient(tier: AiTier, log: LoggerLike): AiClient {
  const tier_cfg = AGENCY_CONFIG.llm.tiers[tier]
  // AI_PROVIDER env overrides the agencyConfig default at deploy time
  const provider =
    (typeof Deno !== 'undefined' ? Deno.env.get('AI_PROVIDER') : undefined) ??
    AGENCY_CONFIG.llm.provider

  if (provider === 'openrouter') {
    return new OpenRouterClient(tier_cfg.openrouterModel, tier_cfg.openrouterFallbacks, log)
  }
  if (provider === 'openai-chat') {
    return new OpenAiChatClient(tier_cfg.nativeModel, log)
  }
  return new OpenAiResponsesClient(tier_cfg.nativeModel, log)
}
```

Per-function model env var overrides (`RESUME_PARSE_MODEL`, etc.) are retired — model
selection now lives entirely in `agencyConfig.ts`. If a one-off model is needed, edit
the config.

### Updated: `logAiUsage`

```typescript
// AiUsageParams gains:
provider: string // 'openai' | 'openrouter' | 'anthropic' — passed by each call site

// logAiUsage inserts params.provider instead of the hardcoded 'openai' literal
```

`TokenUsage` also gains an optional `provider?: string` field so the actual provider
(including the model OpenRouter fell back to) round-trips from the client response.

### Existing functions: index.ts changes only

```typescript
// resume-parse/index.ts — before
import { OpenAiResponsesClient } from '../_shared/ai-client.ts'
const aiClient = new OpenAiResponsesClient(getModel(), log)

// resume-parse/index.ts — after
import { makeAiClient } from '../_shared/ai-client-factory.ts'
const aiClient = makeAiClient('fast', log)

// submittal-fit/index.ts — after
const aiClient = makeAiClient('fast', log)
const graderAiClient = makeAiClient('grader', log)
```

No changes to `resume-parse.ts`, `submittal-fit.ts`, or `fit-grader.ts`.

---

## Environment variables

| Variable             | Purpose                                                  | Default (from agencyConfig) |
| -------------------- | -------------------------------------------------------- | --------------------------- |
| `AI_PROVIDER`        | Override the provider for all functions at deploy time   | `'openai-responses'`        |
| `OPENROUTER_API_KEY` | Required when `AI_PROVIDER=openrouter`                   | —                           |
| `OPENAI_API_KEY`     | Unchanged — used by `openai-responses` and `openai-chat` | —                           |

Per-function model env vars (`RESUME_PARSE_MODEL`, `SUBMITTAL_FIT_MODEL`,
`SUBMITTAL_FIT_GRADER_MODEL`) are **removed** — replaced by `agencyConfig.ts` tier config.

---

## Switching models / providers in practice

**Switch entire backend to OpenRouter with configured fallbacks:**

```
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

Each tier uses its `openrouterModel` + `openrouterFallbacks` from `agencyConfig.ts`.

**Try a different primary model for a tier (edit agencyConfig, no env change needed):**

```typescript
// agencyConfig.ts
fast: {
  openrouterModel: 'deepseek/deepseek-chat-v3-0324',
  openrouterFallbacks: ['openai/gpt-5.4-mini', 'google/gemini-2.5-flash'],
  ...
}
```

**Keep openai-responses in prod, use openrouter in staging:**

```
# staging Doppler
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

---

## Migration path

### Phase 1 — New infrastructure (no behaviour change)

1. Extend `AgencyEdgeConfig` and `AGENCY_CONFIG` with `provider` + `tiers`
2. Add `OpenAiChatClient` to `_shared/ai-client.ts`
3. Add `OpenRouterClient` to `_shared/ai-client.ts` (with fallback `models` array)
4. Add `_shared/ai-client-factory.ts` with `makeAiClient()`
5. Update `logAiUsage` — add `provider` to `AiUsageParams`, remove hardcoded `'openai'`
6. Unit tests: factory routing, `OpenRouterClient` fallback array in request body

### Phase 2 — Wire up existing functions

7. Update `resume-parse/index.ts` — use `makeAiClient('fast', log)`
8. Update `submittal-fit/index.ts` — use `makeAiClient` for both clients
9. Remove now-unused `DEFAULT_MODEL`, `getModel()`, `getGraderModel()` helpers
10. Add `OPENROUTER_API_KEY` as a Doppler secret (staging + prod)

### Phase 3 — Validation

11. Deploy with `AI_PROVIDER=openrouter` in staging; run eval suite (spec 006)
12. Verify fallback fires correctly by temporarily setting a primary model that doesn't
    support structured output (should fall through to first fallback)
13. Compare cost + quality metrics; promote to prod if acceptable

---

## Open questions

1. **Structured output model coverage** — not all OpenRouter-proxied models support
   `response_format: json_schema`. The fallback chains in `agencyConfig.ts` should only
   include models validated to support it. Need to audit the initial defaults.

2. **Token counting discrepancy** — OpenRouter may return different token counts than
   OpenAI for the same prompt (tokenizer differences). Cost dashboards should filter by
   provider when comparing.

3. **`AI_PROVIDER` vs `agencyConfig.provider`** — the env var is a deploy-time override
   and takes precedence. If someone sets `agencyConfig.provider = 'openrouter'` but
   forgets `OPENROUTER_API_KEY`, the function will fail at cold start rather than
   gracefully. The factory should validate the key is present and throw a clear startup
   error.

---

## Files changed

| File                                              | Change                                                         |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `supabase/functions/_shared/agencyConfig.ts`      | Add `provider`, `tiers` to `llm` config                        |
| `supabase/functions/_shared/ai-client.ts`         | Add `OpenAiChatClient`, `OpenRouterClient`                     |
| `supabase/functions/_shared/ai-client-factory.ts` | New — `makeAiClient()` factory                                 |
| `supabase/functions/_shared/log-ai-usage.ts`      | Add `provider` to `AiUsageParams`, remove hardcoded `'openai'` |
| `supabase/functions/resume-parse/index.ts`        | Use `makeAiClient`, remove `getModel()`                        |
| `supabase/functions/submittal-fit/index.ts`       | Use `makeAiClient`, remove `getModel()` / `getGraderModel()`   |
| `tests/unit/_shared/ai-client-factory.test.ts`    | New — factory + fallback routing tests                         |
| `.claude/skills/ai-provider-usage/SKILL.md`       | Update to document factory and `agencyConfig` tiers            |

**No changes to pipeline files** (`resume-parse.ts`, `submittal-fit.ts`, `fit-grader.ts`).
