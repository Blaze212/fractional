/**
 * Promptfoo provider for the submittal-fit GRADER eval.
 *
 * Runs the generator then the grader on each fixture and returns the full
 * response including grade.action — the primary metric for the grader eval.
 * Precision/recall on grade.action vs expected_grade_action is reported after
 * the eval run.
 *
 * Usage: pnpm eval:grader
 */
import OpenAI from 'openai'
import { buildSubmittalSystemPrompt } from '../../supabase/functions/submittal-fit/system-prompt.ts'
import { buildSubmittalPrompt } from '../../supabase/functions/submittal-fit/prompt.ts'
import { FIT_RESULT_SCHEMA } from '../../supabase/functions/submittal-fit/schema.ts'
import type { FitResult } from '../../supabase/functions/submittal-fit/schema.ts'
import type { SubmittalInput } from '../../supabase/functions/submittal-fit/submittal-fit.ts'

const GENERATOR_MODEL = process.env.SUBMITTAL_FIT_MODEL ?? 'gpt-5.4-mini'
const GRADER_MODEL = process.env.SUBMITTAL_FIT_GRADER_MODEL ?? 'gpt-5.4'

interface ProviderContext {
  vars: SubmittalInput & { expected_grade_action?: string }
}

const GRADER_SYSTEM_PROMPT = `You are a skeptical recruiting auditor. Your job is to independently verify whether a candidate submittal narrative is honest and factually grounded.

You will be given:
1. A job description (JD)
2. A candidate profile (the only source of candidate facts)
3. A generated submittal narrative with self-assessment fields

Your task — in order:
1. BEFORE reading the generator's must_have_coverage, independently derive the JD's 3-7 must-have requirements from the JD alone.
2. Score each must-have against the candidate profile independently. Note any gaps the generator under-reported.
3. Assign your own independent fit_level using this rubric:
   - strong: meets 80% or more of must-haves, no fatal gaps
   - moderate: meets some must-haves, 1-2 meaningful gaps
   - weak: misses multiple must-haves, partial overlap only
   - not_recommended: lacks core must-haves
4. Check every employer, title, tool, and non-numeric claim in the narrative against the profile. Flag anything that cannot be verified from the profile.
5. Classify: if there are hallucinated claims → "hallucination"; if the narrative misrepresents fit (wrong level) → "structural"; if clean → "none".

Be adversarial. Your goal is to catch dishonesty, not to validate the generator's claims.`

const GRADER_SCHEMA = {
  type: 'object',
  properties: {
    independent_fit_level: {
      type: 'string',
      enum: ['strong', 'moderate', 'weak', 'not_recommended'],
    },
    under_reported_gaps: { type: 'array', items: { type: 'string' } },
    hallucinated_claims: { type: 'array', items: { type: 'string' } },
    failure_class: { type: 'string', enum: ['hallucination', 'structural', 'none'] },
  },
  required: [
    'independent_fit_level',
    'under_reported_gaps',
    'hallucinated_claims',
    'failure_class',
  ],
  additionalProperties: false,
}

export default class GraderProvider {
  private readonly providerId: string

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? 'submittal-fit-grader'
  }

  id() {
    return this.providerId
  }

  async callApi(_prompt: string, context: ProviderContext) {
    const input = context.vars
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    // Step 1: Run generator
    // deno-lint-ignore no-explicit-any — Responses API typing matches ai-client.ts.
    const genResponse = await (client as any).responses.create({
      model: GENERATOR_MODEL,
      instructions: buildSubmittalSystemPrompt(input.fit_narrative_style_guide),
      input: [{ role: 'user', content: buildSubmittalPrompt(input) }],
      text: {
        format: {
          type: 'json_schema',
          name: 'submittal_fit',
          schema: FIT_RESULT_SCHEMA,
          strict: true,
        },
      },
    })

    const fitResult: FitResult = JSON.parse(genResponse.output_text)

    // Step 2: Determine grade action via Layer 0 + conditional Layer 2
    const profileJson = JSON.stringify(input.parsed_profile)
    const normalize = (s: string) => s.toLowerCase().replace(/[$,\s]/g, '')
    const haystack = normalize(profileJson)
    const allText = [
      fitResult.fit_summary,
      ...fitResult.fit_bullets.map((b) => b.text),
      ...fitResult.key_qualifications.map((b) => b.text),
    ].join(' ')
    const numTokens = (
      allText.toLowerCase().match(/\$?\d[\d,.]*\s?(?:%|k|m|b|bn|x|million|billion)?/g) ?? []
    )
      .map((m) => normalize(m).replace(/[.+]+$/, ''))
      .filter((m) => /\d/.test(m))
    const unsupportedNums = numTokens.filter((t) => !haystack.includes(t))

    // Layer 0 coverage consistency check
    const unmetMustHaves = fitResult.must_have_coverage?.filter((c) => !c.met) ?? []
    const layer0CoverageIssue = fitResult.fit_level === 'strong' && unmetMustHaves.length > 0

    const needsLayer2 =
      fitResult.fit_level !== 'strong' ||
      (fitResult.internal_assessment?.gaps?.length ?? 0) > 0 ||
      unsupportedNums.length > 0 ||
      layer0CoverageIssue

    let gradeAction: 'ship' | 'regenerate' | 'human_review' = 'ship'
    let failureClass: 'none' | 'hallucination' | 'structural' = 'none'
    const issues: string[] = []

    if (unsupportedNums.length > 0)
      issues.push(`Ungrounded numeric figures: ${unsupportedNums.join(', ')}`)
    if (layer0CoverageIssue)
      issues.push(`fit_level "strong" with ${unmetMustHaves.length} unmet must-have(s)`)

    if (needsLayer2) {
      const graderPrompt = `---JOB DESCRIPTION---
${input.jd_text}

---CANDIDATE PROFILE---
${profileJson}

---GENERATOR OUTPUT TO AUDIT---
fit_level claimed: ${fitResult.fit_level}
fit_summary: ${fitResult.fit_summary}
fit_bullets:
${fitResult.fit_bullets.map((b, i) => `  [${i}] ${b.text} (source: ${b.source_ref})`).join('\n')}
must_have_coverage: ${JSON.stringify(fitResult.must_have_coverage ?? [])}
internal gaps: ${JSON.stringify(fitResult.internal_assessment?.gaps ?? [])}`

      // deno-lint-ignore no-explicit-any — Responses API.
      const graderResponse = await (client as any).responses.create({
        model: GRADER_MODEL,
        instructions: GRADER_SYSTEM_PROMPT,
        input: [{ role: 'user', content: graderPrompt }],
        text: {
          format: {
            type: 'json_schema',
            name: 'submittal_fit_grader',
            schema: GRADER_SCHEMA,
            strict: true,
          },
        },
      })

      const graderOutput = JSON.parse(graderResponse.output_text)
      graderOutput.hallucinated_claims.forEach((c: string) => issues.push(`Hallucinated: ${c}`))
      graderOutput.under_reported_gaps.forEach((g: string) =>
        issues.push(`Under-reported gap: ${g}`),
      )

      const hasHallucination =
        unsupportedNums.length > 0 ||
        graderOutput.hallucinated_claims.length > 0 ||
        graderOutput.failure_class === 'hallucination'
      const hasStructural =
        layer0CoverageIssue ||
        graderOutput.under_reported_gaps.length > 0 ||
        graderOutput.failure_class === 'structural'

      if (hasHallucination) {
        gradeAction = 'regenerate'
        failureClass = 'hallucination'
      } else if (hasStructural) {
        gradeAction = 'human_review'
        failureClass = 'structural'
      }
    }

    const output = {
      ...fitResult,
      grade: { action: gradeAction, failure_class: failureClass, issues, warnings: [] },
    }

    return { output }
  }
}
