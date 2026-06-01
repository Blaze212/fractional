# Promptfoo Eval Suite for Submittal-Fit

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-06-01

## Objective

Wire up [Promptfoo](https://promptfoo.dev) with a JS provider to evaluate the
`submittal-fit` generation flow against a set of realistic fixture scenarios.
The eval suite runs on-demand (not in CI by default) with `pnpm eval:submittal`
and verifies structural correctness, grounding, and output quality via
LLM-as-judge assertions.

## Non-goals

- Not a replacement for the existing Vitest unit tests — those stay and cover
  the non-LLM logic. This suite tests what the LLM actually produces.
- Not wired into CI by default — it hits the real OpenAI API and costs tokens.
  A future spec can add a CI gate if regression testing becomes a priority.
- Not a performance benchmark (no latency or cost thresholds).
- Not testing `resume-parse` — only `submittal-fit` generation.

## Architecture

### Directory layout

```
tests/eval/
  promptfooconfig.yaml          # top-level Promptfoo config
  provider.ts                   # Node.js JS provider (calls OpenAI directly)
  fixtures/
    cfo-saas.yaml               # C-level finance, SaaS growth-stage JD
    vp-engineering.yaml         # VP Eng, scaling platform, strong technical JD
    fractional-cmo.yaml         # Fractional CMO, thin profile, sparse JD
```

Add to root `package.json`:

```json
"eval:submittal": "promptfoo eval --config tests/eval/promptfooconfig.yaml"
```

And to `devDependencies`:

```json
"promptfoo": "latest"
```

### The Deno/Node boundary

The edge function source (`system-prompt.ts`, `prompt.ts`, `submittal-fit.ts`)
is Deno TypeScript. The Promptfoo JS provider runs in Node.js — it cannot
import those files directly without pulling in `Deno.*` globals that don't
exist in Node.

**Resolution:** The provider duplicates the two prompt-builder functions
(`buildSubmittalSystemPrompt`, `buildSubmittalPrompt`) in Node-compatible
TypeScript. These functions contain no I/O or side effects; they are pure
string transformations. The `AGENCY_CONFIG.llm.fitNarrativeStyleGuide` string
is imported from a new shared constant file (see below) so it stays in one
place.

If the prompt logic ever diverges between the edge function and the provider,
the fixture assertions will catch the regression — this is the right failure
mode.

### Shared constant file

Extract the agency voice string from `_shared/agencyConfig.ts` into a
framework-agnostic `.ts` file that can be imported by both the Deno edge
function and the Node provider:

```
supabase/functions/_shared/agencyVoice.ts   # pure const, no Deno APIs
```

Both `agencyConfig.ts` (Deno) and `provider.ts` (Node) import from it.
This is the only non-trivial refactor this spec requires.

### `promptfooconfig.yaml`

```yaml
providers:
  - id: file://provider.ts
    label: submittal-fit

tests:
  - file://fixtures/cfo-saas.yaml
  - file://fixtures/vp-engineering.yaml
  - file://fixtures/fractional-cmo.yaml

defaultTest:
  assert:
    # Structural: output must be valid JSON matching FitResult shape
    - type: is-json
    - type: javascript
      value: 'output.fit_bullets?.length === 3'
    - type: javascript
      value: |
        output.fit_bullets.every(b => typeof b.text === 'string' && typeof b.source_ref === 'string')
    - type: javascript
      value: |
        output.key_qualifications?.length >= 3 && output.key_qualifications.length <= 5
    - type: javascript
      value: "typeof output.fit_summary === 'string' && output.fit_summary.trim().length > 0"

    # Grounding: no invented numbers (mirrors findUnsupportedNumbers logic)
    - type: javascript
      value: |
        // Extract numeric tokens from all output text
        const allText = [
          output.fit_summary,
          ...output.fit_bullets.map(b => b.text),
          ...output.key_qualifications.map(b => b.text),
        ].join(' ')
        const normalize = s => s.toLowerCase().replace(/[$,\s]/g, '')
        const tokens = (allText.toLowerCase().match(/\$?\d[\d,.]*\s?(?:%|k|m|b|x|million|billion)?/g) ?? [])
          .map(m => normalize(m).replace(/[.+]+$/, ''))
          .filter(m => /\d/.test(m))
        const haystack = normalize(JSON.stringify(context.vars.parsed_profile))
        return tokens.every(t => haystack.includes(t))

    # Quality: LLM-as-judge — grounding and tone check
    - type: llm-rubric
      value: |
        The fit narrative must:
        1. Contain no invented employers, titles, or metrics absent from the candidate profile
        2. Avoid recruiting clichés ("results-driven", "proven track record", "passionate", "dynamic")
        3. Use active, specific language with at most two sentences per bullet
        4. The fit_summary must position the candidate for this specific role, not describe them generically
```

### `provider.ts`

The provider receives `vars` from each fixture (containing `parsed_profile`,
`jd_text`, `client_name`, `role_title`, and optionally
`fit_narrative_style_guide`). It:

1. Builds the system prompt and user prompt using Node-local copies of the
   builder functions (same logic as the Deno originals)
2. Calls OpenAI Responses API with `gpt-5.4-mini` and the `FIT_RESULT_SCHEMA`
   JSON schema (copied from `schema.ts`)
3. Returns `{ output: parsedJson }` — Promptfoo receives the structured object
   directly; no stdout parsing needed

```typescript
// tests/eval/provider.ts
import OpenAI from 'openai'

// Provider entrypoint called by Promptfoo for each test case
export default {
  async callApi(_prompt: string, context: { vars: Record<string, unknown> }) {
    const { parsed_profile, jd_text, client_name, role_title, fit_narrative_style_guide } =
      context.vars as SubmittalVars

    const systemPrompt = buildSystemPrompt(fit_narrative_style_guide as string | undefined)
    const userPrompt = buildUserPrompt({ parsed_profile, jd_text, client_name, role_title })

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await (client as any).responses.create({
      model: 'gpt-5.4-mini',
      instructions: systemPrompt,
      input: [{ role: 'user', content: userPrompt }],
      text: {
        format: {
          type: 'json_schema',
          name: 'submittal_fit',
          schema: FIT_RESULT_SCHEMA,
          strict: true,
        },
      },
    })

    const output = JSON.parse(response.output_text)
    return { output }
  },
}
```

Promptfoo reads `output` (the parsed object) for all `javascript` and
`llm-rubric` assertions. No stdout parsing; pino logs from the edge function
are irrelevant here since we call OpenAI directly.

### Fixture files

Each fixture supplies the full `parsed_profile` object (same shape as
`ParsedProfile`) plus the job details. Example:

```yaml
# tests/eval/fixtures/cfo-saas.yaml
description: 'C-level finance leader, SaaS growth-stage JD'

vars:
  client_name: Globex
  role_title: Chief Financial Officer
  jd_text: |
    Globex is a Series C SaaS company ($18M ARR) seeking a CFO to own
    FP&A, fundraising, and board reporting through a Series D...
  parsed_profile:
    name: Jane Smith
    current_title: Chief Financial Officer
    total_experience: '15 years'
    summary: 'CFO with 15 years in SaaS finance and two successful capital raises.'
    career_highlights:
      - 'Led $50M Series C at Acme Corp'
      - 'Reduced operating burn 30% through zero-base reforecasting'
    selected_experience:
      - company: Acme Corp
        title: CFO
        start_date: '2019-01'
        end_date: Present
        responsibilities:
          - 'Owned FP&A, treasury, and board reporting for 120-person org'
        achievements:
          - 'Raised $50M Series C; led due-diligence dataroom end-to-end'
          - 'Reduced burn 30% via zero-base reforecast'
    # ... (full ParsedProfile fields)

assert:
  # Scenario-specific: summary must reference the firm or the raise
  - type: javascript
    value: |
      const s = output.fit_summary.toLowerCase()
      s.includes('acme') || s.includes('series') || s.includes('50')
  - type: llm-rubric
    value: |
      The fit_summary and bullets are clearly tailored to the CFO/IPO
      fundraising context; they do not merely list generic finance skills.
```

Three fixtures are required at launch:

| File                  | Scenario                                      | Key assertion                                                     |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `cfo-saas.yaml`       | Strong profile, detailed JD, clear match      | Bullets reference real achievements; no fluff                     |
| `vp-engineering.yaml` | Strong technical profile, platform-scaling JD | Technical specifics from experience cited; no inflated metrics    |
| `fractional-cmo.yaml` | Thin/sparse profile, vague JD                 | Output stays honest — no invented claims; qual output ≥ 3 bullets |

The sparse-profile fixture is the most important: it verifies the model stays
grounded when there is little to work with, rather than hallucinating to fill
the output.

## Running the suite

```bash
# Run all fixtures and print pass/fail per assertion
pnpm eval:submittal

# Open the Promptfoo browser UI (results + prompt diffs)
npx promptfoo view

# Compare two system-prompt variants side by side
pnpm eval:submittal --prompt tests/eval/prompts/v1.txt --prompt tests/eval/prompts/v2.txt
```

`OPENAI_API_KEY` must be set in the shell (the same key already managed via
Doppler for dev; export it before running).

## Implementation Phases

### Phase 1 — Scaffolding

- Add `promptfoo` to root `devDependencies`.
- Create `tests/eval/` and the three fixture YAML files with full `ParsedProfile`
  objects drawn from realistic (anonymised) data.
- Add `eval:submittal` script to `package.json`.

### Phase 2 — Provider + config

- Create `tests/eval/provider.ts` with the prompt builders and OpenAI call.
- Create `tests/eval/promptfooconfig.yaml` with structural + grounding + rubric
  assertions.
- Extract `agencyVoice.ts` from `agencyConfig.ts`; update both import sites.
- Verify `pnpm eval:submittal` runs and all assertions pass.

### Phase 3 — Iteration workflow (optional, after Phase 2)

- Add `tests/eval/prompts/` directory for versioned system-prompt variants.
- Document how to run A/B comparisons in the project README or this spec.

## Acceptance Criteria

- [ ] `pnpm eval:submittal` runs without error against all three fixtures.
- [ ] All structural assertions pass (shape, bullet count, qual count).
- [ ] The grounding assertion catches a manually-injected hallucinated figure in
      a fixture (one fixture should be temporarily patched to confirm the check
      fires, then restored).
- [ ] LLM-rubric assertions pass for the strong-profile fixtures.
- [ ] The sparse-profile fixture produces at least 3 grounded bullets with no
      fabricated claims (rubric assertion).
- [ ] `agencyVoice.ts` extracted; `pnpm typecheck` (including
      `typecheck:functions`) passes.
- [ ] `pnpm format` and `pnpm lint` pass.
- [ ] No `OPENAI_API_KEY` hardcoded anywhere.

## Open Questions

1. **Fixture data** — use fully synthetic profiles or anonymised versions of
   real submittals we've already generated? (Lean: synthetic to avoid any PII
   concern; realistic enough to stress the prompt.)
2. **CI gate** — should a future spec add a nightly eval run against a fixed
   prompt snapshot to catch regressions before a deploy? (Lean: yes, once we
   have a stable baseline — out of scope for this spec.)
3. **Style-guide variant testing** — should fixtures include one run with
   `fit_narrative_style_guide` omitted (fallback path) and one with it
   explicitly set? (Lean: yes, add as a fourth fixture or parameterise the
   CFO fixture with both variants.)
