import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LoggerLike } from '../../supabase/functions/_shared/logger.ts'
import type { AiUsageParams } from '../../supabase/functions/_shared/log-ai-usage.ts'

// --- Mocks (must be hoisted before the module under test is imported) ---

const mockInsert = vi.fn()
const mockFrom = vi.fn(() => ({ insert: mockInsert }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}))

// Import after mocks are hoisted
const { logAiUsage } = await import('../../supabase/functions/_shared/log-ai-usage.ts')

// --- Helpers ---

const silentLogger: LoggerLike = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
}

function makeParams(overrides?: Partial<AiUsageParams>): AiUsageParams {
  return {
    supabaseUrl: 'http://localhost:54321',
    serviceKey: 'test-service-key',
    userId: 'user-abc',
    feature: 'resume-parse',
    tokens: { input: 500, output: 300, model: 'gpt-5.4-mini', latencyMs: 1200 },
    success: true,
    ...overrides,
  }
}

// --- Tests ---

describe('logAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inserts correct row shape on happy path', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await logAiUsage(makeParams(), silentLogger)

    expect(mockFrom).toHaveBeenCalledWith('ai_usage_log')
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-abc',
        session_id: null,
        feature: 'resume-parse',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        input_tokens: 500,
        output_tokens: 300,
        latency_ms: 1200,
        success: true,
        error_code: null,
      }),
    )
  })

  it('forwards latencyMs correctly from TokenUsage', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await logAiUsage(
      makeParams({ tokens: { input: 100, output: 50, latencyMs: 2500 } }),
      silentLogger,
    )

    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ latency_ms: 2500 }))
  })

  it('passes sessionId when provided', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await logAiUsage(makeParams({ sessionId: 'sess-xyz' }), silentLogger)

    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'sess-xyz' }))
  })

  it('sets success=false and errorCode when provided', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await logAiUsage(makeParams({ success: false, errorCode: 'LLM_TIMEOUT' }), silentLogger)

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error_code: 'LLM_TIMEOUT' }),
    )
  })

  it('does not throw when supabase returns an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'rls violation' } })

    await expect(logAiUsage(makeParams(), silentLogger)).resolves.toBeUndefined()
  })

  it('warns when supabase returns an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'rls violation' } })
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await logAiUsage(makeParams(), silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'rls violation', feature: 'resume-parse' }),
      expect.stringContaining('insert failed'),
    )
  })

  it('does not throw when insert rejects unexpectedly', async () => {
    mockInsert.mockRejectedValue(new Error('network error'))

    await expect(logAiUsage(makeParams(), silentLogger)).resolves.toBeUndefined()
  })

  it('warns when insert rejects unexpectedly', async () => {
    mockInsert.mockRejectedValue(new Error('connection refused'))
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await logAiUsage(makeParams(), silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection refused' }),
      expect.stringContaining('unexpected error'),
    )
  })
})
