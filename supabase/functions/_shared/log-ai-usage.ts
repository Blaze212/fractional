import { createClient } from '@supabase/supabase-js'
import type { TokenUsage } from './ai-client.ts'
import type { LoggerLike } from './logger.ts'

export interface UsageContext {
  userId: string
  supabaseUrl: string
  serviceKey: string
}

export interface AiUsageParams {
  supabaseUrl: string
  serviceKey: string
  userId: string
  sessionId?: string
  feature: string
  tokens: TokenUsage
  success: boolean
  errorCode?: string
}

export async function logAiUsage(params: AiUsageParams, log: LoggerLike): Promise<void> {
  try {
    const supabase = createClient(params.supabaseUrl, params.serviceKey)
    const { error } = await supabase.from('ai_usage_log').insert({
      user_id: params.userId,
      session_id: params.sessionId ?? null,
      feature: params.feature,
      provider: 'openai',
      model: params.tokens.model ?? 'unknown',
      input_tokens: params.tokens.input,
      output_tokens: params.tokens.output,
      latency_ms: params.tokens.latencyMs,
      success: params.success,
      error_code: params.errorCode ?? null,
    })
    if (error) {
      log.warn({ err: error.message, feature: params.feature }, 'log-ai-usage: insert failed')
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), feature: params.feature },
      'log-ai-usage: unexpected error',
    )
  }
}
