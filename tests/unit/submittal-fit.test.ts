import { describe, it, expect, vi } from 'vitest'
import {
  validateSubmittalInput,
  runFitGeneration,
  extractNumericTokens,
  findUnsupportedNumbers,
} from '../../supabase/functions/submittal-fit/submittal-fit.ts'
import type { Deps, SubmittalInput } from '../../supabase/functions/submittal-fit/submittal-fit.ts'
import type { FitResult } from '../../supabase/functions/submittal-fit/schema.ts'
import type { ParsedProfile } from '../../supabase/functions/resume-parse/schema.ts'
import type { AiClient } from '../../supabase/functions/_shared/ai-client.ts'
import type { LoggerLike } from '../../supabase/functions/_shared/logger.ts'

const silentLogger: LoggerLike = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
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
}

function makeMockAiClient(
  data: FitResult = groundedResult,
  override?: Partial<AiClient>,
): AiClient {
  return {
    completeJson: vi.fn().mockResolvedValue({
      data,
      tokens: { input: 600, output: 200, model: 'gpt-5.4-mini' },
    }),
    ...override,
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

describe('runFitGeneration', () => {
  it('returns a grounded result with exactly 3 bullets, a summary, and key qualifications', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { result, meta } = await runFitGeneration(baseInput, deps, silentLogger)
    expect(result.fit_bullets).toHaveLength(3)
    expect(result.fit_summary).toBeTruthy()
    expect(result.key_qualifications).toHaveLength(3)
    expect(result.key_qualifications[0].source_ref).toBe('selected_experience[0]')
    expect(meta.model).toBe('gpt-5.4-mini')
  })

  it('allows zero key qualifications for a poor fit with no supporting points', async () => {
    const noQuals: FitResult = { ...groundedResult, key_qualifications: [] }
    const deps: Deps = { aiClient: makeMockAiClient(noQuals) }
    const { result } = await runFitGeneration(baseInput, deps, silentLogger)
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
    await expect(runFitGeneration(baseInput, deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('flags an ungrounded figure that appears only in a key qualification', async () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      key_qualifications: [
        { text: 'Managed a $999M portfolio.', source_ref: 'selected_experience[0]' },
        groundedResult.key_qualifications[1],
        groundedResult.key_qualifications[2],
      ],
    }
    const deps: Deps = { aiClient: makeMockAiClient(hallucinated) }
    await expect(runFitGeneration(baseInput, deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('passes the submittal schema name and grounding inputs to the AI client', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(baseInput, { aiClient }, silentLogger)
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
    )
    const systemPrompt = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(systemPrompt).toContain('House rule: no exclamation marks.')
  })

  it('falls back to the default agency voice when no style guide is provided', async () => {
    const aiClient = makeMockAiClient()
    await runFitGeneration(baseInput, { aiClient }, silentLogger)
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
    await expect(runFitGeneration(baseInput, deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('throws when the output contains a figure absent from the input profile', async () => {
    const hallucinated: FitResult = {
      ...groundedResult,
      fit_bullets: [
        { text: 'Closed $8M in net-new ARR.', source_ref: 'selected_experience[0]' },
        groundedResult.fit_bullets[1],
        groundedResult.fit_bullets[2],
      ],
    }
    const deps: Deps = { aiClient: makeMockAiClient(hallucinated) }
    await expect(runFitGeneration(baseInput, deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    })
  })

  it('wraps an AI client failure as UnprocessableEntity', async () => {
    const deps: Deps = {
      aiClient: makeMockAiClient(groundedResult, {
        completeJson: vi.fn().mockRejectedValue(new Error('OpenAI timeout')),
      }),
    }
    await expect(runFitGeneration(baseInput, deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      status: 422,
    })
  })
})
