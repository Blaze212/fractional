import { describe, it, expect, vi } from 'vitest'
import {
  validateResumeText,
  runParsing,
} from '../../supabase/functions/resume-parse/resume-parse.ts'
import type { Deps } from '../../supabase/functions/resume-parse/resume-parse.ts'
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
  summary: 'Experienced CFO with 15+ years in SaaS finance.',
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
    {
      company: 'OldCo',
      title: 'VP Finance',
      start_date: '2015-06',
      end_date: '2018-12',
    },
  ],
  education: [{ institution: 'Harvard', degree: 'MBA' }],
  certifications: [{ provider: 'AICPA', certification: 'CPA' }],
  skills: ['Financial planning', 'M&A', 'Board relations'],
  tools: ['NetSuite', 'Carta', 'Excel'],
  seniority_level: 'C-Level',
  functional_areas: ['Finance', 'Operations'],
  industries: ['SaaS', 'Fintech'],
}

function makeMockAiClient(override?: Partial<AiClient>): AiClient {
  return {
    completeJson: vi
      .fn()
      .mockResolvedValue({
        data: mockProfile,
        tokens: { input: 500, output: 300, model: 'gpt-5.4-mini' },
      }),
    ...override,
  }
}

describe('validateResumeText', () => {
  it('returns error for null', () => {
    const result = validateResumeText(null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('required')
  })

  it('returns error for empty string', () => {
    const result = validateResumeText('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('empty')
  })

  it('returns error for oversized input', () => {
    const longText = 'a'.repeat(60_001)
    const result = validateResumeText(longText)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('limit')
  })

  it('returns trimmed text for valid input', () => {
    const result = validateResumeText('  Jane Smith\nCFO at Acme  ')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('Jane Smith\nCFO at Acme')
    }
  })

  it('accepts exactly max chars', () => {
    const text = 'a'.repeat(60_000)
    const result = validateResumeText(text)
    expect(result.ok).toBe(true)
  })
})

describe('runParsing', () => {
  it('returns profile and meta on successful LLM call', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { profile, meta } = await runParsing('Jane Smith CFO...', deps, silentLogger)

    expect(profile.name).toBe('Jane Smith')
    expect(profile.selected_experience).toHaveLength(1)
    expect(profile.other_experience).toHaveLength(1)
    expect(meta.model).toBe('gpt-5.4-mini')
    expect(meta.input_char_count).toBe('Jane Smith CFO...'.length)
  })

  it('calls completeJson with correct schema name', async () => {
    const aiClient = makeMockAiClient()
    const deps: Deps = { aiClient }
    await runParsing('Some resume text', deps, silentLogger)

    expect(aiClient.completeJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Some resume text'),
      'parsed_profile',
      expect.objectContaining({ type: 'object' }),
    )
  })

  it('throws UnprocessableEntityException when LLM call fails', async () => {
    const deps: Deps = {
      aiClient: makeMockAiClient({
        completeJson: vi.fn().mockRejectedValue(new Error('OpenAI timeout')),
      }),
    }

    await expect(runParsing('Some resume', deps, silentLogger)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      status: 422,
    })
  })

  it('selected_experience and other_experience are present in response', async () => {
    const deps: Deps = { aiClient: makeMockAiClient() }
    const { profile } = await runParsing('resume text', deps, silentLogger)

    expect(Array.isArray(profile.selected_experience)).toBe(true)
    expect(Array.isArray(profile.other_experience)).toBe(true)
    expect(profile.selected_experience[0].responsibilities).toBeInstanceOf(Array)
    expect(profile.selected_experience[0].achievements).toBeInstanceOf(Array)
  })

  it('passes resume text to the prompt builder', async () => {
    const aiClient = makeMockAiClient()
    const deps: Deps = { aiClient }
    const resumeText = 'My unique resume content 12345'
    await runParsing(resumeText, deps, silentLogger)

    const callArgs = (aiClient.completeJson as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1]).toContain(resumeText)
  })
})
