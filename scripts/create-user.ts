import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54421'
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!key) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('Usage: pnpm create-user <email> <password>')
  process.exit(1)
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
})

if (error) {
  console.error('Error:', error.message)
  process.exit(1)
}

console.log('Created user:', data.user.id, data.user.email)
