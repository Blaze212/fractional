import type { AiClient, JsonSchema } from '../_shared/ai-client.ts'
import type { LoggerLike } from '../_shared/logger.ts'
import type { FitResult, FitLevel } from './schema.ts'
import type { SubmittalInput } from './submittal-fit.ts'
import { findUnsupportedNumbers } from './grounding.ts'

export type GradeAction = 'ship' | 'regenerate' | 'human_review'
export type FailureClass = 'hallucination' | 'structural' | 'none'

export interface FitGrade {
  action: GradeAction
  failure_class: FailureClass
  issues: string[]
  warnings: string[]
}

export interface GraderDeps {
  graderAiClient: AiClient
}

// Phrases that signal hype — forbidden when fit_level is not 'strong'.
const BANNED_PHRASES = [
  'ideal fit',
  'perfect fit',
  'exceptional fit',
  'outstanding fit',
  'uniquely qualified',
  'tailor-made',
  'tailor made',
]

// --- Layer 0: pure deterministic checks ---

export function checkBannedPhrases(result: FitResult): string[] {
  if (result.fit_level === 'strong') return []
  const texts = [
    result.fit_summary,
    ...result.fit_bullets.map((b) => b.text),
    ...result.key_qualifications.map((b) => b.text),
  ]
  const hits: string[] = []
  for (const phrase of BANNED_PHRASES) {
    if (texts.some((t) => t.toLowerCase().includes(phrase))) {
      hits.push(`Banned phrase "${phrase}" used with fit_level "${result.fit_level}"`)
    }
  }
  return hits
}

export function checkCoverageConsistency(result: FitResult): string[] {
  if (result.fit_level !== 'strong') return []
  const unmet = result.must_have_coverage.filter((c) => !c.met)
  if (unmet.length === 0) return []
  return [
    `fit_level is "strong" but ${unmet.length} must-have(s) are unmet: ` +
      unmet.map((u) => `"${u.requirement}"`).join(', '),
  ]
}

// Runs all Layer 0 checks and returns the combined issues list.
export function runLayer0Checks(
  result: FitResult,
  profile: Parameters<typeof findUnsupportedNumbers>[1],
): string[] {
  const issues: string[] = []
  issues.push(...checkBannedPhrases(result))
  issues.push(...checkCoverageConsistency(result))
  const unsupported = findUnsupportedNumbers(result, profile)
  if (unsupported.length > 0) {
    issues.push(`Ungrounded numeric figures: ${unsupported.join(', ')}`)
  }
  return issues
}

// --- Risk gate ---

function shouldRunLayer2(result: FitResult, layer0Issues: string[]): boolean {
  return (
    result.fit_level !== 'strong' ||
    result.internal_assessment.gaps.length > 0 ||
    layer0Issues.length > 0
  )
}

// --- Layer 2: LLM grader ---

const FIT_LEVEL_VALUES: FitLevel[] = ['strong', 'moderate', 'weak', 'not_recommended']

interface GraderOutput {
  independent_fit_level: FitLevel
  under_reported_gaps: string[]
  hallucinated_claims: string[]
  failure_class: FailureClass
}

const GRADER_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    independent_fit_level: {
      type: 'string',
      enum: FIT_LEVEL_VALUES,
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

function buildGraderSystemPrompt(): string {
  return `You are a skeptical recruiting auditor. Your job is to independently verify whether a candidate submittal narrative is honest and factually grounded.

You will be given:
1. A job description (JD)
2. A candidate profile (the only source of candidate facts)
3. A generated submittal narrative with self-assessment fields

Your task — in order:
1. BEFORE reading the generator's must_have_coverage, independently derive the JD's 3–7 must-have requirements from the JD alone.
2. Score each must-have against the candidate profile independently. Note any gaps the generator under-reported.
3. Assign your own independent fit_level using this rubric:
   - strong: meets ≥80% of must-haves, no fatal gaps
   - moderate: meets some must-haves, 1–2 meaningful gaps
   - weak: misses multiple must-haves, partial overlap only
   - not_recommended: lacks core must-haves
4. Check every employer, title, tool, and non-numeric claim in the narrative against the profile. Flag anything that cannot be verified from the profile.
5. Classify: if there are hallucinated claims → "hallucination"; if the narrative misrepresents fit (wrong level) → "structural"; if clean → "none".

Be adversarial. Your goal is to catch dishonesty, not to validate the generator's claims.`
}

function buildGraderPrompt(input: SubmittalInput, result: FitResult): string {
  return `---JOB DESCRIPTION---
${input.jd_text}

---CANDIDATE PROFILE (only source of facts)---
${JSON.stringify(input.parsed_profile, null, 2)}

---GENERATOR OUTPUT TO AUDIT---
fit_level claimed: ${result.fit_level}
fit_summary: ${result.fit_summary}
fit_bullets:
${result.fit_bullets.map((b, i) => `  [${i}] ${b.text} (source: ${b.source_ref})`).join('\n')}
key_qualifications:
${result.key_qualifications.map((b, i) => `  [${i}] ${b.text} (source: ${b.source_ref})`).join('\n')}
must_have_coverage claimed:
${JSON.stringify(result.must_have_coverage, null, 2)}
internal gaps claimed: ${JSON.stringify(result.internal_assessment.gaps)}`
}

async function runLayer2Grader(
  input: SubmittalInput,
  result: FitResult,
  deps: GraderDeps,
  log: LoggerLike,
): Promise<GraderOutput> {
  log.info('submittal-fit: running Layer 2 LLM grader')
  const res = await deps.graderAiClient.completeJson<GraderOutput>(
    buildGraderSystemPrompt(),
    buildGraderPrompt(input, result),
    'submittal_fit_grader',
    GRADER_OUTPUT_SCHEMA,
  )
  return res.data
}

// --- Main grader entry point ---

export async function gradeFit(
  input: SubmittalInput,
  result: FitResult,
  deps: GraderDeps,
  log: LoggerLike,
): Promise<FitGrade> {
  const layer0Issues = runLayer0Checks(result, input.parsed_profile)

  if (!shouldRunLayer2(result, layer0Issues)) {
    return { action: 'ship', failure_class: 'none', issues: [], warnings: [] }
  }

  const layer0Numeric = layer0Issues.filter((i) => i.startsWith('Ungrounded numeric'))
  const layer0Structural = layer0Issues.filter((i) => !i.startsWith('Ungrounded numeric'))

  let graderOutput: GraderOutput
  try {
    graderOutput = await runLayer2Grader(input, result, deps, log)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ err: msg }, 'submittal-fit: Layer 2 grader failed — failing safe to human_review')
    return {
      action: 'human_review',
      failure_class: 'none',
      issues: [...layer0Issues],
      warnings: ['Grader call failed; manual review required'],
    }
  }

  const allIssues: string[] = [
    ...layer0Issues,
    ...graderOutput.hallucinated_claims.map((c) => `Hallucinated claim: ${c}`),
    ...graderOutput.under_reported_gaps.map((g) => `Under-reported gap: ${g}`),
  ]

  const hasHallucination =
    layer0Numeric.length > 0 ||
    graderOutput.hallucinated_claims.length > 0 ||
    graderOutput.failure_class === 'hallucination'

  const hasStructural =
    layer0Structural.length > 0 ||
    graderOutput.under_reported_gaps.length > 0 ||
    graderOutput.failure_class === 'structural'

  if (!hasHallucination && !hasStructural) {
    return { action: 'ship', failure_class: 'none', issues: [], warnings: [] }
  }

  if (hasHallucination) {
    return { action: 'regenerate', failure_class: 'hallucination', issues: allIssues, warnings: [] }
  }

  // Structural issues (weak fit, missing must-haves) — don't retry.
  return { action: 'human_review', failure_class: 'structural', issues: allIssues, warnings: [] }
}
