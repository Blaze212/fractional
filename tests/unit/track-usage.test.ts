import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LoggerLike } from '../../supabase/functions/_shared/logger.ts'

// --- Mocks (must be hoisted before the module under test is imported) ---

const mockInsert = vi.fn()
const mockMaybeSingle = vi.fn()
// update chain: .update({}).eq('user_id', ...).eq('tool', ...) → Promise
const mockUpdateEq2 = vi.fn()
const mockUpdateEq1 = vi.fn(() => ({ eq: mockUpdateEq2 }))
const mockUpdateFn = vi.fn(() => ({ eq: mockUpdateEq1 }))

// Chain builders for select: .select(...).eq(...).eq(...).maybeSingle()
const selectChain = {
  eq: vi.fn(() => selectChain),
  maybeSingle: mockMaybeSingle,
}
const mockSelect = vi.fn(() => selectChain)

const mockFrom = vi.fn((table: string) => {
  if (table === 'usage_events') return { insert: mockInsert }
  if (table === 'usage_limits')
    return { insert: mockInsert, select: mockSelect, update: mockUpdateFn }
  return { insert: mockInsert }
})

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

describe('trackUsageEvent — usage_events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsert.mockResolvedValue({ error: null })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockUpdateEq2.mockResolvedValue({ error: null })
    mockUpdateEq1.mockReturnValue({ eq: mockUpdateEq2 })
    selectChain.eq.mockReturnValue(selectChain)
  })

  it('calls supabase insert with correct user_id and event_type', async () => {
    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(mockFrom).toHaveBeenCalledWith('usage_events')
    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'user-abc', event_type: 'resume_parse' })
  })

  it('handles submittal_fit event type', async () => {
    await trackUsageEvent('user-xyz', 'submittal_fit', silentLogger)

    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'user-xyz', event_type: 'submittal_fit' })
  })

  it('does not throw when supabase returns an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'connection timeout' } })

    await expect(trackUsageEvent('user-abc', 'resume_parse', silentLogger)).resolves.toBeUndefined()
  })

  it('logs a warning when usage_events insert returns an error', async () => {
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

describe('trackUsageEvent — usage_limits upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsert.mockResolvedValue({ error: null })
    mockUpdateEq2.mockResolvedValue({ error: null })
    mockUpdateEq1.mockReturnValue({ eq: mockUpdateEq2 })
    selectChain.eq.mockReturnValue(selectChain)
  })

  it('first call inserts row with usage_count=1 and lifetime_count=1', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(mockFrom).toHaveBeenCalledWith('usage_limits')
    const insertCalls = mockInsert.mock.calls
    const limitsInsert = insertCalls.find(
      (call) => call[0] && 'tool' in (call[0] as Record<string, unknown>),
    )
    expect(limitsInsert).toBeDefined()
    expect(limitsInsert![0]).toMatchObject({
      user_id: 'user-abc',
      tool: 'resume_parse',
      usage_count: 1,
      lifetime_count: 1,
    })
  })

  it('second call within period increments usage_count and lifetime_count', async () => {
    const recentStart = new Date(Date.now() - 60_000).toISOString() // 1 minute ago
    mockMaybeSingle.mockResolvedValue({
      data: { usage_count: 1, period_start: recentStart, lifetime_count: 1 },
      error: null,
    })

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(mockUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({ usage_count: 2, lifetime_count: 2 }),
    )
  })

  it('call after period expiry resets usage_count to 1 and increments lifetime_count', async () => {
    const oldStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago
    mockMaybeSingle.mockResolvedValue({
      data: { usage_count: 5, period_start: oldStart, lifetime_count: 10 },
      error: null,
    })

    await trackUsageEvent('user-abc', 'submittal_fit', silentLogger)

    expect(mockUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({ usage_count: 1, lifetime_count: 11 }),
    )
    // period_start should be updated (a fresh ISO string)
    const updateArg = mockUpdateFn.mock.calls[0][0] as Record<string, unknown>
    expect(updateArg.period_start).not.toBe(oldStart)
  })

  it('does not throw when usage_limits upsert returns an error', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockInsert.mockResolvedValue({ error: { message: 'rls error' } })

    await expect(trackUsageEvent('user-abc', 'resume_parse', silentLogger)).resolves.toBeUndefined()
  })

  it('warns when usage_limits insert fails', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    const firstInsertSucceeds = { error: null }
    const secondInsertFails = { error: { message: 'rls violation' } }
    mockInsert
      .mockResolvedValueOnce(firstInsertSucceeds) // usage_events
      .mockResolvedValueOnce(secondInsertFails) // usage_limits
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'rls violation', tool: 'resume_parse' }),
      expect.stringContaining('insert failed'),
    )
  })

  it('warns when usage_limits update fails', async () => {
    const recentStart = new Date(Date.now() - 60_000).toISOString()
    mockMaybeSingle.mockResolvedValue({
      data: { usage_count: 1, period_start: recentStart, lifetime_count: 1 },
      error: null,
    })
    mockUpdateEq2.mockResolvedValue({ error: { message: 'update failed' } })
    const warnSpy = vi.spyOn(silentLogger, 'warn')

    await trackUsageEvent('user-abc', 'resume_parse', silentLogger)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'update failed', tool: 'resume_parse' }),
      expect.stringContaining('update failed'),
    )
  })
})
