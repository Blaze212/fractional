import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadSupabaseAdminEnv } from './env.ts'
import type { LoggerLike } from './logger.ts'

const PERIOD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface UsageLimitRow {
  usage_count: number
  period_start: string
  lifetime_count: number
}

async function upsertUsageLimit(
  supabase: SupabaseClient,
  userId: string,
  tool: string,
  log: LoggerLike,
): Promise<void> {
  try {
    const now = new Date().toISOString()

    const { data: existing, error: selectError } = await supabase
      .from('usage_limits')
      .select('usage_count, period_start, lifetime_count')
      .eq('user_id', userId)
      .eq('tool', tool)
      .maybeSingle()

    if (selectError) {
      log.warn({ err: selectError.message, tool }, 'track-usage: usage_limits select failed')
      return
    }

    if (!existing) {
      const { error } = await supabase
        .from('usage_limits')
        .insert({ user_id: userId, tool, usage_count: 1, period_start: now, lifetime_count: 1 })
      if (error) {
        log.warn({ err: error.message, tool }, 'track-usage: usage_limits insert failed')
      }
      return
    }

    const row = existing as UsageLimitRow
    const periodExpired = Date.now() - new Date(row.period_start).getTime() >= PERIOD_MS
    const { error } = await supabase
      .from('usage_limits')
      .update({
        usage_count: periodExpired ? 1 : row.usage_count + 1,
        period_start: periodExpired ? now : row.period_start,
        lifetime_count: row.lifetime_count + 1,
      })
      .eq('user_id', userId)
      .eq('tool', tool)
    if (error) {
      log.warn({ err: error.message, tool }, 'track-usage: usage_limits update failed')
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), tool },
      'track-usage: usage_limits unexpected error',
    )
  }
}

export async function trackUsageEvent(
  userId: string,
  eventType: string,
  log: LoggerLike,
): Promise<void> {
  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadSupabaseAdminEnv()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { error } = await supabase
      .from('usage_events')
      .insert({ user_id: userId, event_type: eventType })
    if (error) {
      log.warn({ err: error.message, eventType }, 'track-usage: insert failed')
    }

    await upsertUsageLimit(supabase, userId, eventType, log)
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType },
      'track-usage: unexpected error',
    )
  }
}
