export function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function loadSupabaseUserEnv() {
  return {
    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_ANON_KEY: requireEnv('SUPABASE_ANON_KEY'),
  }
}

export function loadSupabaseAdminEnv() {
  return {
    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY:
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
      Deno.env.get('SERVICE_ROLE_KEY') ||
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  }
}

export function loadOpenAiEnv() {
  return {
    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  }
}
