import { describe, expect, it } from 'vitest'

// @ts-expect-error standalone zero-dependency script, no type declarations
import {
  MODELS,
  audioFormatFor,
  buildRequestBody,
  estimateCost,
  parseVocab,
  resolveModel,
} from '../../scripts/stt-transcribe.mjs'

describe('resolveModel', () => {
  it('resolves a seeded alias', () => {
    expect(resolveModel('qwen').id).toBe('qwen/qwen3-asr-flash-2026-02-10')
    expect(resolveModel('whisper').provider).toBe('groq')
  })

  it('resolves a full OpenRouter model ID back to its alias', () => {
    expect(resolveModel('openai/gpt-transcribe').alias).toBe('gpt')
  })

  it('passes through an unseeded model ID', () => {
    const model = resolveModel('deepgram/nova-3')
    expect(model.id).toBe('deepgram/nova-3')
    expect(model.provider).toBeNull()
  })

  it('throws on an unknown alias', () => {
    expect(() => resolveModel('nope')).toThrow(/Unknown model/)
  })
})

describe('parseVocab', () => {
  it('drops comments and blanks, joins the rest', () => {
    expect(parseVocab('# note\n\nSupabase\nDoppler\n')).toBe('Supabase, Doppler')
  })

  it('deduplicates repeated terms', () => {
    expect(parseVocab('Supabase\nSupabase\nDoppler')).toBe('Supabase, Doppler')
  })

  it('returns an empty string for a comment-only file', () => {
    expect(parseVocab('# just a comment\n\n')).toBe('')
  })
})

describe('audioFormatFor', () => {
  it('maps known extensions case-insensitively', () => {
    expect(audioFormatFor('/tmp/a.WAV')).toBe('wav')
    expect(audioFormatFor('/tmp/a.mp3')).toBe('mp3')
    expect(audioFormatFor('/tmp/a.oga')).toBe('ogg')
  })

  it('throws on an unsupported extension', () => {
    expect(() => audioFormatFor('/tmp/a.txt')).toThrow(/Unsupported audio extension/)
  })
})

describe('estimateCost', () => {
  it('converts per-second, per-minute and per-hour rates over 600s', () => {
    expect(estimateCost(MODELS.qwen, 600)).toBeCloseTo(0.021, 6)
    expect(estimateCost(MODELS.gpt, 600)).toBeCloseTo(0.045, 6)
    expect(estimateCost(MODELS.whisper, 600)).toBeCloseTo(0.0185, 6)
  })

  it('returns null when duration is unknown', () => {
    expect(estimateCost(MODELS.qwen, undefined)).toBeNull()
  })
})

describe('buildRequestBody', () => {
  const base = { audioBase64: 'AAAA', format: 'wav' as const }

  it('pins the provider and nests vocab under its option key', () => {
    const body = buildRequestBody({ ...base, model: resolveModel('whisper'), vocab: 'Supabase' })
    expect(body.provider.order).toEqual(['groq'])
    expect(body.provider.allow_fallbacks).toBe(false)
    expect(body.provider.options).toEqual({ groq: { prompt: 'Supabase' } })
  })

  it('omits the options block when no vocab is supplied', () => {
    const body = buildRequestBody({ ...base, model: resolveModel('qwen'), vocab: '' })
    expect(body.provider.options).toBeUndefined()
  })

  it('honours a provider override', () => {
    const body = buildRequestBody({
      ...base,
      model: resolveModel('whisper'),
      provider: 'deepinfra',
      vocab: 'x',
    })
    expect(body.provider.order).toEqual(['deepinfra'])
    expect(body.provider.options).toEqual({ deepinfra: { prompt: 'x' } })
  })

  it('only sets language when one is given', () => {
    expect(buildRequestBody({ ...base, model: resolveModel('gpt') }).language).toBeUndefined()
    expect(buildRequestBody({ ...base, model: resolveModel('gpt'), language: 'en' }).language).toBe(
      'en',
    )
  })
})
