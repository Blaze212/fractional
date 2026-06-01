import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LoggerLike } from '../../supabase/functions/_shared/logger.ts'

// --- Mocks (must be hoisted before the module under test is imported) ---

const mockInsert = vi.fn()
const mockFrom = vi.fn(() => ({ insert: mockInsert }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}))

vi.mock('../../supabase/functions/_shared/env.ts', () => ({
  loadSupabaseAdminEnv: vi.fn(() => ({
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  })),
  requireEnv: vi.fn((key: string) => {
    const vals: Record<string, string> = { SUPABASE_URL: 'http://localhost:54321' }
    if (vals[key]) return vals[key]
    throw new Error(`Missing required environment variable: ${key}`)
  }),
}))

// Import after mocks are hoisted
const { trackUsageEvent } = await import('../../supabase/functions/_shared/track-usage.ts')

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

// --- Tests ---

describe('trackUsageEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls supabase insert with correct user_id and event_type', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(mockFrom).toHaveBeenCalledWith('usage_events')
    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'user-abc', event_type: 'resume_parse' })
  })

  it('handles submittal_fit event type', async () => {
    mockInsert.mockResolvedValue({ error: null })

    await trackUsageEvent('user-xyz', 'submittal_fit', silentLogger)

    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'user-xyz', event_type: 'submittal_fit' })
  })

  it('does not throw when supabase returns an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'connection timeout' } })

    await expect(trackUsageEvent('user-abc', 'resume_parse', silentLogger)).resolves.toBeUndefined()
  })

  it('logs a warning when supabase returns an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'unique violation' } })
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'unique violation', eventType: 'resume_parse' }),
      expect.stringContaining('insert failed'),
    )
  })

  it('does not throw when insert rejects with an unexpected error', async () => {
    mockInsert.mockRejectedValue(new Error('network error'))

    await expect(trackUsageEvent('user-abc', 'resume_parse', silentLogger)).resolves.toBeUndefined()
  })

  it('logs a warning when insert rejects unexpectedly', async () => {
    mockInsert.mockRejectedValue(new Error('unexpected crash'))
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await trackUsageEvent('user-abc', 'submittal_fit', silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'unexpected crash', eventType: 'submittal_fit' }),
      expect.stringContaining('unexpected error'),
    )
  })

  it('does not throw when loadSupabaseAdminEnv throws', async () => {
    const { loadSupabaseAdminEnv } = await import('../../supabase/functions/_shared/env.ts')
    vi.mocked(loadSupabaseAdminEnv).mockImplementationOnce(() => {
      throw new Error('missing env var')
    })

    await expect(trackUsageEvent('user-abc', 'resume_parse', silentLogger)).resolves.toBeUndefined()
  })

  it('logs a warning when env loading fails', async () => {
    const { loadSupabaseAdminEnv } = await import('../../supabase/functions/_shared/env.ts')
    vi.mocked(loadSupabaseAdminEnv).mockImplementationOnce(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
    })
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'SUPABASE_SERVICE_ROLE_KEY not set' }),
      expect.any(String),
    )
  })
})
