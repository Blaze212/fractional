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

// Phrases forbidden in client-facing fields (fit_summary, fit_bullets, key_qualifications).
// Hype phrases: forbidden when fit_level is not 'strong'.
// Gap-disclosure phrases: forbidden at all fit levels (gap details belong in internal_assessment).
const BANNED_PHRASES = [
  'ideal fit',
  'perfect fit',
  'exceptional fit',
  'outstanding fit',
  'uniquely qualified',
  'tailor-made',
  'tailor made',
  // Gap-disclosure language — never appropriate in client-facing copy
  'partial fit',
  'weak fit',
  'not a fit',
  'main gaps',
  'key gaps',
  'gaps are',
  'the gaps are',
]

// Phrases that are only banned for non-strong fit levels (hype detection).
const HYPE_ONLY_PHRASES = new Set([
  'ideal fit',
  'perfect fit',
  'exceptional fit',
  'outstanding fit',
  'uniquely qualified',
  'tailor-made',
  'tailor made',
])

// --- Layer 0: pure deterministic checks ---

export function checkBannedPhrases(result: FitResult): string[] {
  const texts = [
    result.fit_summary,
    ...result.fit_bullets.map((b) => b.text),
    ...result.key_qualifications.map((b) => b.text),
  ]
  const hits: string[] = []
  for (const phrase of BANNED_PHRASES) {
    const isHypeOnly = HYPE_ONLY_PHRASES.has(phrase)
    if (isHypeOnly && result.fit_level === 'strong') continue
    if (texts.some((t) => t.toLowerCase().includes(phrase))) {
      hits.push(`Banned phrase "${phrase}" found in client-facing copy`)
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
  return `You are a factual-grounding auditor for candidate submittals. Your job is to catch fabricated facts — not to penalise reasonable professional inferences.

You will be given:
1. A job description (JD)
2. A candidate profile (the only source of candidate facts)
3. A generated submittal narrative

Your task in order:
1. Independently derive the 3–5 must-have requirements from the JD.
2. Score each against the candidate profile and assign your own fit_level:
   - strong: meets ≥80% of must-haves, no fatal gaps
   - moderate: meets some must-haves, 1–2 meaningful gaps
   - weak: misses multiple must-haves, partial overlap only
   - not_recommended: lacks core must-haves
3. Identify up to 3 concrete gaps between the JD must-haves and the profile. Focus on genuinely missing skills, frameworks, or experience areas — not stylistic concerns.
4. Check for TRUE fabrications only. A claim is a hallucination ONLY when the underlying fact is absent from the profile entirely:
   - FABRICATION: a specific employer, degree, certification, or project not found anywhere in the profile
   - FABRICATION: a numeric metric (dollar figure, percentage, headcount) that does not appear anywhere in the profile
   - NOT A FABRICATION: characterising depth of a skill that IS listed (e.g. "strong Python experience" when Python is in the tools list)
   - NOT A FABRICATION: inferring leadership, architecture, or backend experience from role descriptions that support it
   - NOT A FABRICATION: reasonable professional language around a skill or achievement grounded in the profile
   Report at most 3 fabrications with high confidence. When in doubt, omit.
5. Set failure_class:
   - "hallucination" — only when step 4 found at least one genuinely fabricated fact
   - "structural" — when the narrative significantly overstates the fit level (e.g. presents a weak candidate as strong with no supporting evidence)
   - "none" — gaps or overstatements present, but no fabrication and no material fit misrepresentation`
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

  const hasHallucination =
    layer0Numeric.length > 0 ||
    graderOutput.hallucinated_claims.length > 0 ||
    graderOutput.failure_class === 'hallucination'

  // Structural only when the grader explicitly flags fit misrepresentation or
  // Layer 0 deterministic checks fire — NOT just because gaps were found.
  const hasStructural = layer0Structural.length > 0 || graderOutput.failure_class === 'structural'

  if (!hasHallucination && !hasStructural) {
    // Gaps only — surface as soft amber warnings, no confirmation required.
    return {
      action: 'ship',
      failure_class: 'none',
      issues: [],
      warnings: graderOutput.under_reported_gaps.slice(0, 3),
    }
  }

  if (hasHallucination) {
    return {
      action: 'regenerate',
      failure_class: 'hallucination',
      issues: [
        ...layer0Issues,
        ...graderOutput.hallucinated_claims.slice(0, 3).map((c) => `Hallucinated claim: ${c}`),
      ],
      warnings: [],
    }
  }

  // Structural: fit level significantly misrepresented — flag for human review.
  return {
    action: 'human_review',
    failure_class: 'structural',
    issues: [
      ...layer0Structural,
      ...graderOutput.under_reported_gaps.slice(0, 3).map((g) => `Gap: ${g}`),
    ],
    warnings: [],
  }
}
