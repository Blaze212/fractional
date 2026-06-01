import { describe, it, expect, vi } from 'vitest'
import {
  validateSubmittalInput,
  runFitGeneration,
  extractNumericTokens,
  findUnsupportedNumbers,
} from '../../supabase/functions/submittal-fit/submittal-fit.ts'
import type {
  Deps,
  SubmittalInput,
  UsageContext,
} from '../../supabase/functions/submittal-fit/submittal-fit.ts'
import type { FitResult } from '../../supabase/functions/submittal-fit/schema.ts'
import {
  checkBannedPhrases,
  checkCoverageConsistency,
  runLayer0Checks,
  gradeFit,
} from '../../supabase/functions/submittal-fit/fit-grader.ts'
import type { GraderDeps } from '../../supabase/functions/submittal-fit/fit-grader.ts'
import type { ParsedProfile } from '../../supabase/functions/resume-parse/schema.ts'
import type { AiClient } from '../../supabase/functions/_shared/ai-client.ts'
import type { LoggerLike } from '../../supabase/functions/_shared/logger.ts'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })),
  })),
}))

const silentLogger: LoggerLike = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
}

const mockUsageCtx: UsageContext = {
  userId: 'test-user',
  supabaseUrl: 'http://localhost:54321',
  serviceKey: 'test-service-key',
}

const mockProfile: ParsedProfile = {
  name: 'Jane Smith',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'New York, NY',
  linkedin_url: 'https://linkedin.com/in/janesmith',
  current_title: 'Chief Financial Officer',
  work_authorization: 'U.S. Citizen',
  total_experience: '15 years',
  summary: 'Experienced CFO with 15 years in SaaS finance.',
  career_highlights: ['Led $50M Series C', 'Reduced burn by 30%'],
  selected_experience: [
    {
      company: 'Acme Corp',
      title: 'CFO',
      start_date: '2019-01',
      end_date: 'Present',
      responsibilities: ['Oversaw all financial operations'],
      achievements: ['Raised $50M Series C'],
    },
  ],
  other_experience: [
    { company: 'OldCo', title: 'VP Finance', start_date: '2015-06', end_date: '2018-12' },
  ],
  education: [{ institution: 'Harvard', degree: 'MBA' }],
  certifications: [{ provider: 'AICPA', certification: 'CPA' }],
  skills: ['Financial planning', 'M&A', 'Board relations'],
  tools: ['NetSuite', 'Carta', 'Excel'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance', 'Operations'],
  industries: ['SaaS', 'Fintech'],
}

const groundedResult: FitResult = {
  fit_bullets: [
    { text: 'Raised a $50M Series C as CFO at Acme Corp.', source_ref: 'selected_experience[0]' },
    { text: 'Reduced burn by 30% across the finance org.', source_ref: 'career_highlights[1]' },
    { text: 'Deep SaaS and fintech finance leadership.', source_ref: 'industries' },
  ],
  fit_summary: 'A C-Level SaaS finance leader well suited to scale this role.',
  key_qualifications: [
    { text: 'Oversaw all financial operations.', source_ref: 'selected_experience[0]' },
    { text: 'Raised $50M Series C.', source_ref: 'selected_experience[0]' },
    { text: 'Reduced burn by 30%.', source_ref: 'career_highlights[1]' },
  ],
  jd_must_haves: ['CFO experience', 'Series C+ fundraising', 'SaaS background'],
  must_have_coverage: [
    { requirement: 'CFO experience', met: true, evidence: 'selected_experience[0]' },
    { requirement: 'Series C+ fundraising', met: true, evidence: 'career_highlights[0]' },
    { requirement: 'SaaS background', met: true, evidence: 'industries' },
  ],
  fit_level: 'strong',
  internal_assessment: { gaps: [] },
}

function makeMockAiClient(
  data: FitResult = groundedResult,
  override?: Partial<AiClient>,
): AiClient {
  return {
    completeJson: vi.fn().mockResolvedValue({
      data,
      tokens: { input: 600, output: 200, model: 'gpt-5.4-mini', latencyMs: 1000 },
    }),
    ...override,
  }
}

function makeGraderClient(
  graderData: {
    independent_fit_level: string
    under_reported_gaps: string[]
    hallucinated_claims: string[]
    failure_class: string
  } = {
    independent_fit_level: 'strong',
    under_reported_gaps: [],
    hallucinated_claims: [],
    failure_class: 'none',
  },
): AiClient {
  return {
    completeJson: vi.fn().mockResolvedValue({
      data: graderData,
      tokens: { input: 400, output: 100, model: 'gpt-5.4', latencyMs: 800 },
    }),
  }
}

const baseInput: SubmittalInput = {
  parsed_profile: mockProfile,
  jd_text: 'We need a CFO to lead finance through Series D.',
  client_name: 'Globex',
  role_title: 'Chief Financial Officer',
}

describe('validateSubmittalInput', () => {
  it('accepts a complete, valid body', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'A job description',
      client_name: 'Globex',
      role_title: 'CFO',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.client_name).toBe('Globex')
  })

  it('rejects a missing/invalid parsed_profile', () => {
    const result = validateSubmittalInput({
      parsed_profile: null,
      jd_text: 'jd',
      client_name: 'Globex',
      role_title: 'CFO',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('parsed_profile')
  })

  it('rejects empty jd_text', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: '   ',
      client_name: 'Globex',
      role_title: 'CFO',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('jd_text')
  })

  it('rejects missing client_name', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'jd',
      client_name: '',
      role_title: 'CFO',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('client_name')
  })

  it('rejects missing role_title', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'jd',
      client_name: 'Globex',
      role_title: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('role_title')
  })

  it('trims whitespace from text fields', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: '  jd  ',
      client_name: '  Globex  ',
      role_title: '  CFO  ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.client_name).toBe('Globex')
      expect(result.value.jd_text).toBe('jd')
    }
  })

  it('passes through an optional fit_narrative_style_guide', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'jd',
      client_name: 'Globex',
      role_title: 'CFO',
      fit_narrative_style_guide: 'Be terse and punchy.',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.fit_narrative_style_guide).toBe('Be terse and punchy.')
  })

  it('leaves fit_narrative_style_guide undefined when not provided', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'jd',
      client_name: 'Globex',
      role_title: 'CFO',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.fit_narrative_style_guide).toBeUndefined()
  })

  it('rejects an over-length fit_narrative_style_guide', () => {
    const result = validateSubmittalInput({
      parsed_profile: mockProfile,
      jd_text: 'jd',
      client_name: 'Globex',
      role_title: 'CFO',
      fit_narrative_style_guide: 'x'.repeat(10_001),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('fit_narrative_style_guide')
  })
})

describe('extractNumericTokens', () => {
  it('extracts dollar/unit figures', () => {
    expect(extractNumericTokens('Raised $50M Series C')).toContain('50m')
  })

  it('extracts percentages', () => {
    expect(extractNumericTokens('Reduced burn by 30%')).toContain('30%')
  })

  it('returns nothing for figure-free text', () => {
    expect(extractNumericTokens('Led the finance organization')).toHaveLength(0)
  })
})

describe('findUnsupportedNumbers (anti-hallucination)', () => {
  it('returns empty when all figures are present in the profile', () => {
    expect(findUnsupportedNumbers(groundedResult, mockProfile)).toHaveLength(0)
  })

  it('flags a fabricated figure absent from the profile', () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      fit_bullets: [
        { text: 'Drove $8M in new ARR last year.', source_ref: 'selected_experience[0]' },
        groundedResult.fit_bullets[1],
        groundedResult.fit_bullets[2],
      ],
    }
    const unsupported = findUnsupportedNumbers(hallucinated, mockProfile)
    expect(unsupported).toContain('8m')
  })

  it('flags a fabricated figure in the summary', () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      fit_summary: 'Grew revenue 400% in a single year.',
    }
    expect(findUnsupportedNumbers(hallucinated, mockProfile)).toContain('400%')
  })
})

describe('checkBannedPhrases (Layer 0)', () => {
  it('returns no issues for a strong fit with no banned phrases', () => {
    expect(checkBannedPhrases(groundedResult)).toHaveLength(0)
  })

  it('skips hype-phrase check for strong fit_level', () => {
    const withHype: FitResult = {
      ...groundedResult,
      fit_level: 'strong',
      fit_summary: 'This is an ideal fit for the role.',
    }
    expect(checkBannedPhrases(withHype)).toHaveLength(0)
  })

  it('flags a hype phrase for non-strong fit_level', () => {
    const weakWithHype: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      fit_summary: 'This is an ideal fit for the role.',
    }
    const issues = checkBannedPhrases(weakWithHype)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain('ideal fit')
  })

  it('detects hype phrases in bullets for non-strong fits', () => {
    const result: FitResult = {
      ...groundedResult,
      fit_level: 'weak',
      fit_bullets: [
        { text: 'A perfect fit for this role.', source_ref: 'summary' },
        groundedResult.fit_bullets[1],
        groundedResult.fit_bullets[2],
      ],
    }
    const issues = checkBannedPhrases(result)
    expect(issues.some((i) => i.includes('perfect fit'))).toBe(true)
  })

  it('flags "partial fit" in fit_summary even for strong fit_level', () => {
    const result: FitResult = {
      ...groundedResult,
      fit_level: 'strong',
      fit_summary: 'Jane is a partial fit for this role.',
    }
    const issues = checkBannedPhrases(result)
    expect(issues.some((i) => i.includes('partial fit'))).toBe(true)
  })

  it('flags gap-disclosure phrases at any fit_level', () => {
    const cases: Array<{ phrase: string; summary: string }> = [
      { phrase: 'partial fit', summary: 'Barton is a partial fit for this role.' },
      { phrase: 'main gaps', summary: 'The main gaps are certification and Trello.' },
      { phrase: 'gaps are', summary: 'The gaps are formal tenure and scrum cert.' },
      { phrase: 'not a fit', summary: 'Candidate is not a fit for this position.' },
    ]
    for (const { phrase, summary } of cases) {
      for (const fit_level of ['strong', 'moderate', 'weak', 'not_recommended'] as const) {
        const result: FitResult = { ...groundedResult, fit_level, fit_summary: summary }
        const issues = checkBannedPhrases(result)
        expect(issues.some((i) => i.includes(phrase))).toBe(true)
      }
    }
  })
})

describe('checkCoverageConsistency (Layer 0)', () => {
  it('returns no issues when strong fit has all must-haves met', () => {
    expect(checkCoverageConsistency(groundedResult)).toHaveLength(0)
  })

  it('returns no issues for non-strong fit_level with unmet must-haves', () => {
    const moderate: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      must_have_coverage: [
        { requirement: 'CFO experience', met: true, evidence: 'selected_experience[0]' },
        { requirement: 'Scrum Master cert', met: false, evidence: null },
      ],
    }
    expect(checkCoverageConsistency(moderate)).toHaveLength(0)
  })

  it('flags strong fit_level when any must-have is unmet', () => {
    const lying: FitResult = {
      ...groundedResult,
      fit_level: 'strong',
      must_have_coverage: [
        { requirement: 'CFO experience', met: true, evidence: 'selected_experience[0]' },
        { requirement: 'Blockchain cert', met: false, evidence: null },
      ],
    }
    const issues = checkCoverageConsistency(lying)
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain('strong')
    expect(issues[0]).toContain('Blockchain cert')
  })
})

describe('runLayer0Checks (Layer 0 combined)', () => {
  it('returns no issues for a clean grounded result', () => {
    expect(runLayer0Checks(groundedResult, mockProfile)).toHaveLength(0)
  })

  it('returns numeric grounding issue for fabricated figure', () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      fit_summary: 'Drove $999M in revenue last year.',
    }
    const issues = runLayer0Checks(hallucinated, mockProfile)
    expect(issues.some((i) => i.includes('Ungrounded numeric'))).toBe(true)
  })

  it('returns banned-phrase issue for moderate result with hype', () => {
    const hype: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      fit_summary: 'A uniquely qualified candidate for this role.',
    }
    const issues = runLayer0Checks(hype, mockProfile)
    expect(issues.some((i) => i.includes('uniquely qualified'))).toBe(true)
  })

  it('returns coverage consistency issue for sycophantic strong claim', () => {
    const lying: FitResult = {
      ...groundedResult,
      fit_level: 'strong',
      must_have_coverage: [{ requirement: 'PSM certification', met: false, evidence: null }],
    }
    const issues = runLayer0Checks(lying, mockProfile)
    expect(issues.some((i) => i.includes('strong') && i.includes('PSM'))).toBe(true)
  })
})

describe('runFitGeneration', () => {
  it('returns a grounded result with exactly 3 bullets, a summary, and key qualifications', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { result, meta } = await runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx)
    expect(result.fit_bullets).toHaveLength(3)
    expect(result.fit_summary).toBeTruthy()
    expect(result.key_qualifications).toHaveLength(3)
    expect(result.key_qualifications[0].source_ref).toBe('selected_experience[0]')
    expect(meta.model).toBe('gpt-5.4-mini')
  })

  it('returns a grade field alongside result and meta', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { grade } = await runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx)
    expect(grade).toMatchObject({ action: 'ship', failure_class: 'none', issues: [], warnings: [] })
  })

  it('returns default ship grade when graderDeps is absent', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { grade } = await runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx)
    expect(grade.action).toBe('ship')
    expect(grade.failure_class).toBe('none')
  })

  it('allows zero key qualifications for a poor fit with no supporting points', async () => {
    const noQuals: FitResult = { ...groundedResult, key_qualifications: [] }
    const deps: Deps = { aiClient: makeMockAiClient(noQuals) }
    const { result } = await runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx)
    expect(result.key_qualifications).toEqual([])
  })

  it('throws when more than 5 key qualifications are returned', async () => {
    const tooMany: FitResult = {
      ...groundedResult,
      key_qualifications: Array.from({ length: 6 }, () => ({
        text: 'Oversaw all financial operations.',
        source_ref: 'selected_experience[0]',
      })),
    }
    const deps: Deps = { aiClient: makeMockAiClient(tooMany) }
    await expect(
      runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('does not detect ungrounded figures without graderDeps (grader-only check)', async () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      key_qualifications: [
        { text: 'Managed a $999M portfolio.', source_ref: 'selected_experience[0]' },
        groundedResult.key_qualifications[1],
        groundedResult.key_qualifications[2],
      ],
    }
    const deps: Deps = { aiClient: makeMockAiClient(hallucinated) }
    // Without graderDeps, numeric hallucinations are not caught — grader is required.
    const { grade } = await runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx)
    expect(grade.action).toBe('ship')
  })

  it('passes the submittal schema name and grounding inputs to the AI client', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(baseInput, { aiClient }, silentLogger, mockUsageCtx)
    expect(aiClient.completeJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Globex'),
      'submittal_fit',
      expect.objectContaining({ type: 'object' }),
    )
    const prompt = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(prompt).toContain('Acme Corp')
    expect(prompt).toContain('We need a CFO')
  })

  it('injects the caller-provided style guide into the system prompt', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(
      { ...baseInput, fit_narrative_style_guide: 'House rule: no exclamation marks.' },
      { aiClient },
      silentLogger,
      mockUsageCtx,
    )
    const systemPrompt = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(systemPrompt).toContain('House rule: no exclamation marks.')
  })

  it('falls back to the default agency voice when no style guide is provided', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(baseInput, { aiClient }, silentLogger, mockUsageCtx)
    const systemPrompt = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    // Marker unique to the appended default style guide (not the base prompt).
    expect(systemPrompt).toContain('proven track record')
  })

  it('omits the style guide entirely when an empty string is provided', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(
      { ...baseInput, fit_narrative_style_guide: '   ' },
      { aiClient },
      silentLogger,
      mockUsageCtx,
    )
    const systemPrompt = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    // The default style guide must not be appended; its unique marker is absent.
    expect(systemPrompt).not.toContain('proven track record')
  })

  it('throws when the model returns other than 3 bullets', async () => {
    const twoBullets: FitResult = {
      ...groundedResult,
      fit_bullets: groundedResult.fit_bullets.slice(0, 2),
    }
    const deps: Deps = { aiClient: makeMockAiClient(twoBullets) }
    await expect(
      runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('wraps an AI client failure as UnprocessableEntity', async () => {
    const deps: Deps = {
      aiClient: makeMockAiClient(groundedResult, {
        completeJson: vi.fn().mockRejectedValue(new Error('OpenAI timeout')),
      }),
    }
    await expect(
      runFitGeneration(baseInput, deps, silentLogger, mockUsageCtx),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      status: 422,
    })
  })
})

describe('runFitGeneration with graderDeps (integration paths)', () => {
  it('returns ship grade when grader reports clean output', async () => {
    const aiClient = makeMockAiClient()
    const graderAiClient = makeGraderClient()
    const { grade } = await runFitGeneration(
      baseInput,
      { aiClient, graderDeps: { graderAiClient } },
      silentLogger,
      mockUsageCtx,
    )
    // strong fit, no gaps → Layer 2 skipped, direct ship
    expect(grade.action).toBe('ship')
    expect(grade.failure_class).toBe('none')
  })

  it('returns human_review with structural class for weak-fit candidate', async () => {
    const weakResult: FitResult = {
      ...groundedResult,
      fit_level: 'weak',
      internal_assessment: { gaps: ['Missing core certification'] },
    }
    const aiClient = makeMockAiClient(weakResult)
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'weak',
      under_reported_gaps: ['No SaaS experience'],
      hallucinated_claims: [],
      failure_class: 'structural',
    })
    const { grade } = await runFitGeneration(
      baseInput,
      { aiClient, graderDeps: { graderAiClient } },
      silentLogger,
      mockUsageCtx,
    )
    expect(grade.action).toBe('human_review')
    expect(grade.failure_class).toBe('structural')
    expect(grade.issues.length).toBeGreaterThan(0)
  })

  it('auto-regenerates once on hallucination and returns ship when retry is clean', async () => {
    const hallucinatedResult: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: ['Minor gap'] },
    }
    const cleanResult = groundedResult
    const aiClient = makeMockAiClient()
    const completeJsonFn = vi
      .fn()
      .mockResolvedValueOnce({
        data: hallucinatedResult,
        tokens: { input: 600, output: 200, model: 'gpt-5.4-mini', latencyMs: 1000 },
      })
      .mockResolvedValueOnce({
        data: cleanResult,
        tokens: { input: 600, output: 200, model: 'gpt-5.4-mini', latencyMs: 1000 },
      })
    aiClient.completeJson = completeJsonFn

    // Grader: first call says hallucination, second call says clean
    const graderCompleteJsonFn = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          independent_fit_level: 'moderate',
          under_reported_gaps: [],
          hallucinated_claims: ['Invented employer XYZ'],
          failure_class: 'hallucination',
        },
        tokens: { input: 400, output: 100, model: 'gpt-5.4', latencyMs: 800 },
      })
      .mockResolvedValueOnce({
        data: {
          independent_fit_level: 'strong',
          under_reported_gaps: [],
          hallucinated_claims: [],
          failure_class: 'none',
        },
        tokens: { input: 400, output: 100, model: 'gpt-5.4', latencyMs: 800 },
      })
    const graderAiClient: AiClient = { completeJson: graderCompleteJsonFn }

    const { result, grade } = await runFitGeneration(
      baseInput,
      { aiClient, graderDeps: { graderAiClient } },
      silentLogger,
      mockUsageCtx,
    )
    expect(grade.action).toBe('ship')
    expect(result.fit_bullets).toHaveLength(3)
    expect(completeJsonFn).toHaveBeenCalledTimes(2)
  })

  it('returns human_review with hallucination class when retry also fails', async () => {
    const hallucinatedResult: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: ['Minor gap'] },
    }
    const aiClient = makeMockAiClient(hallucinatedResult)

    const graderAiClient: AiClient = {
      completeJson: vi.fn().mockResolvedValue({
        data: {
          independent_fit_level: 'moderate',
          under_reported_gaps: [],
          hallucinated_claims: ['Still hallucinating after retry'],
          failure_class: 'hallucination',
        },
        tokens: { input: 400, output: 100, model: 'gpt-5.4', latencyMs: 800 },
      }),
    }

    const { grade } = await runFitGeneration(
      baseInput,
      { aiClient, graderDeps: { graderAiClient } },
      silentLogger,
      mockUsageCtx,
    )
    expect(grade.action).toBe('human_review')
    expect(grade.failure_class).toBe('hallucination')
  })

  it('fails safe to human_review when grader LLM call throws', async () => {
    // Use a non-strong result so the risk gate trips and grader LLM is actually called.
    const weakResult: FitResult = {
      ...groundedResult,
      fit_level: 'weak',
      internal_assessment: { gaps: ['Missing required cert'] },
    }
    const aiClient = makeMockAiClient(weakResult)
    const graderAiClient: AiClient = {
      completeJson: vi.fn().mockRejectedValue(new Error('Grader network timeout')),
    }
    const { grade } = await runFitGeneration(
      baseInput,
      { aiClient, graderDeps: { graderAiClient } },
      silentLogger,
      mockUsageCtx,
    )
    expect(grade.action).toBe('human_review')
    expect(grade.warnings).toContain('Grader call failed; manual review required')
  })
})

describe('gradeFit (direct grader function)', () => {
  it('returns ship immediately for clean strong result without calling grader LLM', async () => {
    const graderAiClient = makeGraderClient()
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, groundedResult, deps, silentLogger, mockUsageCtx)
    expect(grade.action).toBe('ship')
    expect(graderAiClient.completeJson).not.toHaveBeenCalled()
  })

  it('calls grader LLM for non-strong fit_level', async () => {
    const nonStrong: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: ['Gap A'] },
    }
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'moderate',
      under_reported_gaps: [],
      hallucinated_claims: [],
      failure_class: 'structural',
    })
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, nonStrong, deps, silentLogger, mockUsageCtx)
    expect(graderAiClient.completeJson).toHaveBeenCalledOnce()
    expect(grade.action).toBe('human_review')
    expect(grade.failure_class).toBe('structural')
  })

  it('calls grader LLM when Layer 0 finds a numeric issue', async () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      fit_summary: 'Drove $999M in revenue.',
    }
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'strong',
      under_reported_gaps: [],
      hallucinated_claims: ['$999M figure not in profile'],
      failure_class: 'hallucination',
    })
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, hallucinated, deps, silentLogger, mockUsageCtx)
    expect(graderAiClient.completeJson).toHaveBeenCalledOnce()
    expect(grade.action).toBe('regenerate')
    expect(grade.failure_class).toBe('hallucination')
  })

  it('returns ship with warnings when grader finds only gaps (failure_class none)', async () => {
    const moderate: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: ['No Kafka experience'] },
    }
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'moderate',
      under_reported_gaps: ['No Kafka experience', 'No Spring Boot'],
      hallucinated_claims: [],
      failure_class: 'none',
    })
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, moderate, deps, silentLogger, mockUsageCtx)
    expect(grade.action).toBe('ship')
    expect(grade.failure_class).toBe('none')
    expect(grade.issues).toHaveLength(0)
    expect(grade.warnings).toContain('No Kafka experience')
    expect(grade.warnings).toContain('No Spring Boot')
  })

  it('caps warnings at 3 even when grader returns more than 3 gaps', async () => {
    const moderate: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: [] },
    }
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'moderate',
      under_reported_gaps: ['Gap 1', 'Gap 2', 'Gap 3', 'Gap 4', 'Gap 5'],
      hallucinated_claims: [],
      failure_class: 'none',
    })
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, moderate, deps, silentLogger, mockUsageCtx)
    expect(grade.action).toBe('ship')
    expect(grade.warnings).toHaveLength(3)
  })

  it('does not escalate to human_review/structural for gaps alone (failure_class none)', async () => {
    const moderate: FitResult = {
      ...groundedResult,
      fit_level: 'moderate',
      internal_assessment: { gaps: ['Some gap'] },
    }
    const graderAiClient = makeGraderClient({
      independent_fit_level: 'moderate',
      under_reported_gaps: ['Missing Spring Boot', 'No Kafka'],
      hallucinated_claims: [],
      failure_class: 'none',
    })
    const deps: GraderDeps = { graderAiClient }
    const grade = await gradeFit(baseInput, moderate, deps, silentLogger, mockUsageCtx)
    expect(grade.action).not.toBe('human_review')
  })
})
