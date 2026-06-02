import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { PasswordInput } from '../components/PasswordInput'

function getPasswordErrors(pw: string): string[] {
  const errors: string[] = []
  if (pw.length < 8) errors.push('Must be at least 8 characters')
  if (!/[a-zA-Z]/.test(pw)) errors.push('Must contain letters')
  if (!/[0-9]/.test(pw)) errors.push('Must contain numbers')
  return errors
}

export default function UpdatePasswordPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // Guards against StrictMode/remount double-invocation consuming the
  // single-use recovery token twice (the second call always fails).
  const linkProcessed = useRef(false)

  useEffect(() => {
    if (linkProcessed.current) return
    linkProcessed.current = true

    const tokenHash = searchParams.get('token_hash')
    const type = searchParams.get('type')
    const code = searchParams.get('code')

    ;(async () => {
      try {
        if (tokenHash && type) {
          // Sign out any existing session first — identity is determined by the link,
          // preventing cross-account confusion when a user clicks a link for another account.
          await supabase.auth.signOut()

          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as EmailOtpType,
          })
          if (error) {
            setError(error.message)
            setHasSession(false)
            return
          }
          // Strip params from URL after successful verification
          setSearchParams({}, { replace: true })
        } else if (code) {
          await supabase.auth.signOut()
          const { error } = await supabase.auth.exchangeCodeForSession(code)
          if (error) {
            setError(error.message)
            setHasSession(false)
            return
          }
          setSearchParams({}, { replace: true })
        }

        const {
          data: { session },
        } = await supabase.auth.getSession()

        setHasSession(!!session)
        if (session?.user?.email) setUserEmail(session.user.email)
      } catch {
        setHasSession(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // process link params once on mount only

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const pwErrors = getPasswordErrors(password)
    if (pwErrors.length > 0) {
      setError(pwErrors.join('\n'))
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      setDone(true)
      setTimeout(() => navigate('/resume-templater', { replace: true }), 2000)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <h1 className="text-brand text-2xl font-bold">Set New Password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Choose a strong password so you can sign in anytime.
          </p>
        </div>

        {done ? (
          <div className="space-y-2 py-4 text-center">
            <div className="text-4xl">✓</div>
            <p className="font-semibold text-slate-900">Password updated</p>
            <p className="text-sm text-slate-500">Redirecting you to the portal…</p>
          </div>
        ) : hasSession === null ? (
          <div className="py-4 text-center">
            <p className="font-semibold text-slate-900">Verifying your link…</p>
            <p className="mt-1 text-sm text-slate-500">One moment while we sign you in securely.</p>
          </div>
        ) : hasSession === false ? (
          <div className="space-y-4 py-4 text-center">
            <p className="font-semibold text-slate-900">Link expired or invalid</p>
            <p className="text-sm text-slate-500">
              This reset link can only be used once and may have expired. Request a new one below.
            </p>
            <Link
              to="/reset-password"
              className="bg-brand hover:bg-brand-light inline-block w-full rounded-lg px-4 py-2.5 text-center text-sm font-semibold text-white"
            >
              Request new reset link →
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {userEmail && (
              <p className="text-sm text-slate-500">
                Setting password for <span className="font-medium text-slate-900">{userEmail}</span>
              </p>
            )}
            <PasswordInput
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <PasswordInput
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
            {error && (
              <ul className="space-y-1">
                {error.split('\n').map((msg) => (
                  <li key={msg} className="text-sm text-red-600">
                    {msg}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="submit"
              disabled={submitting || hasSession === null}
              className="bg-brand hover:bg-brand-light w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Updating…' : 'Update Password →'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
