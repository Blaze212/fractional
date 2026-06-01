import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    // redirectTo must be allow-listed in the Supabase dashboard
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/update-password`,
    })

    // Always show the generic confirmation — enumeration-safe
    setSubmitted(true)
    setSubmitting(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <h1 className="text-brand text-2xl font-bold">Reset Password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your email and we&apos;ll send a reset link.
          </p>
        </div>

        {submitted ? (
          <div className="bg-brand-muted text-brand rounded-lg p-4 text-sm">
            If an account exists for that email, you&apos;ll receive a reset link shortly.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="focus:border-brand focus:ring-brand w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-1"
            />
            <button
              type="submit"
              disabled={submitting}
              className="bg-brand hover:bg-brand-light w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send Reset Link →'}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-slate-500">
          <Link to="/login" className="text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
