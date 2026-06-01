import OpenAI from 'openai'
import { FIT_NARRATIVE_STYLE_GUIDE } from '../../supabase/functions/_shared/agencyVoice.ts'
import type { SubmittalInput } from '../../supabase/functions/submittal-fit/submittal-fit.ts'

// LLM-as-judge SCORECARD assertion for `submittal-fit`.
//
// Unlike `llm-rubric` (a binary pass/fail grader), this emits a per-category
// 1–10 score with justification. The scores are returned as promptfoo
// `namedScores` (0–1) so they aggregate into a per-metric average across all
// fixtures in `npx promptfoo view` — the comparison surface for prompt-eval
// A/B runs. The full 1–10 breakdown + justifications are in `reason`.
//
// Diagnostic by default: it does NOT fail a case. Set EVAL_OVERALL_MIN (1–10)
// to gate the run on the judge's Overall score if you want a hard floor.

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? 'gpt-5.4'
const OVERALL_MIN = Number(process.env.EVAL_OVERALL_MIN ?? '7') // 0 ⇒ non-gating

// Display label → short metric key (promptfoo namedScores key; no spaces).
const CATEGORIES: { key: string; label: string; description: string }[] = [
  {
    key: 'FactualAccuracy',
    label: 'Factual Accuracy',
    description:
      'Factual accuracy / grounding — no employer, title, or metric absent from the profile.',
  },
  {
    key: 'OverallQuality',
    label: 'Overall Quality',
    description: 'Overall quality and persuasiveness as a hiring-manager narrative.',
  },
  {
    key: 'RoleFit',
    label: 'Role Fit',
    description: 'Fit for the role based on the profile provided.',
  },
  {
    key: 'Clarity',
    label: 'Clarity',
    description: 'Clarity and specificity of the bullets.',
  },
  {
    key: 'Readability',
    label: 'Readability',
    description: 'Readability.',
  },
  {
    key: 'AgencyVoice',
    label: 'Agency Voice',
    description: 'Adherence to the AGENCY VOICE guidelines.',
  },
  {
    key: 'Relevance',
    label: 'Relevance',
    description:
      'Output pulled the most relevant and compelling information from the profile to make the case for fit.',
  },
  {
    key: 'Overall',
    label: 'Overall',
    description: 'Overall score, 1–10, weighing all of the above criteria.',
  },
]

const SCORE_ITEM = {
  type: 'object',
  properties: {
    key: { type: 'string', enum: CATEGORIES.map((c) => c.key) },
    score: { type: 'integer' },
    justification: { type: 'string' },
  },
  required: ['key', 'score', 'justification'],
  additionalProperties: false,
}

const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: SCORE_ITEM,
      minItems: CATEGORIES.length,
      maxItems: CATEGORIES.length,
    },
  },
  required: ['scores'],
  additionalProperties: false,
}

interface ScoreItem {
  key: string
  score: number
  justification: string
}

// promptfoo passes the provider output (an object, since the provider returns
// `{ output }`) and a context carrying the fixture `vars`.
interface AssertionContext {
  vars: SubmittalInput
}

interface GradingResult {
  pass: boolean
  score: number
  reason: string
  namedScores?: Record<string, number>
}

function clamp1to10(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(10, Math.max(1, Math.round(n)))
}

function buildJudgePrompt(output: unknown, ctx: AssertionContext): string {
  const styleGuide = ctx.vars.fit_narrative_style_guide ?? FIT_NARRATIVE_STYLE_GUIDE
  return `You are grading a recruiting-agency candidate submittal narrative produced by an LLM.

Score the GENERATED OUTPUT on each category below from 1 to 10 (10 = best). Provide a brief justification for every score, and always explain scores under 7. Judge factual grounding and role fit strictly against the CANDIDATE PROFILE — any employer, title, or metric not present in the profile must lower Factual Accuracy.

CATEGORIES (use the exact key):
${CATEGORIES.map((c) => `- ${c.key}: ${c.description}`).join('\n')}

---CLIENT---
${ctx.vars.client_name}

---ROLE---
${ctx.vars.role_title}

---JOB DESCRIPTION---
${ctx.vars.jd_text}

---AGENCY VOICE GUIDELINES---
${styleGuide}

---CANDIDATE PROFILE (the only source of candidate facts)---
${JSON.stringify(ctx.vars.parsed_profile, null, 2)}

---GENERATED OUTPUT (the narrative under evaluation)---
${JSON.stringify(output, null, 2)}`
}

export default async function scorecard(
  output: unknown,
  context: AssertionContext,
): Promise<GradingResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  let parsed: { scores: ScoreItem[] }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Responses API typing matches ai-client.ts.
    const response = await (client as any).responses.create({
      model: JUDGE_MODEL,
      instructions:
        'You are a meticulous, skeptical evaluator of recruiting submittals. Return only the requested JSON scores.',
      input: [{ role: 'user', content: buildJudgePrompt(output, context) }],
      text: {
        format: {
          type: 'json_schema',
          name: 'submittal_scorecard',
          schema: SCORECARD_SCHEMA,
          strict: true,
        },
      },
    })
    parsed = JSON.parse(response.output_text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { pass: false, score: 0, reason: `Scorecard judge failed: ${message}` }
  }

  const byKey = new Map(parsed.scores.map((s) => [s.key, s]))
  const namedScores: Record<string, number> = {}
  const lines: string[] = []
  for (const c of CATEGORIES) {
    const item = byKey.get(c.key)
    const raw = clamp1to10(item?.score ?? 1)
    namedScores[c.key] = raw / 10 // promptfoo metric convention is 0–1
    lines.push(`• ${c.label}: ${raw}/10 — ${item?.justification ?? '(no justification returned)'}`)
  }

  const overall = clamp1to10(byKey.get('Overall')?.score ?? 1)
  const pass = overall >= OVERALL_MIN
  const gate = OVERALL_MIN > 0 ? ` (gate: Overall ≥ ${OVERALL_MIN})` : ' (diagnostic — non-gating)'

  return {
    pass,
    score: overall / 10,
    reason: `Scorecard (1–10)${gate}:\n${lines.join('\n')}`,
    namedScores,
  }
}
