import { createClient } from '@supabase/supabase-js'
import { loadSupabaseAdminEnv } from './env.ts'
import type { LoggerLike } from './logger.ts'

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
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), eventType },
      'track-usage: unexpected error',
    )
  }
}
