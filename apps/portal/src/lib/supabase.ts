import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Email/password only (no OAuth/magic links), and password recovery uses a
    // `{{ .TokenHash }}` link redeemed via verifyOtp. PKCE emits a browser-bound
    // `pkce_` token that verifyOtp can't redeem, breaking recovery cross-device.
    flowType: 'implicit',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
