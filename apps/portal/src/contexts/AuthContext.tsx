import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  loading: true,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  // Skip auth bootstrap on the update-password route so recovery links aren't
  // disrupted by the provider's session handling.
  const shouldBypassAuthBootstrap = pathname === '/update-password'
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(() => !shouldBypassAuthBootstrap)

  useEffect(() => {
    if (shouldBypassAuthBootstrap) return

    let isActive = true

    ;(async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (isActive) setSession(session)
      } catch {
        if (isActive) setSession(null)
      } finally {
        if (isActive) setLoading(false)
      }
    })()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Callback must stay synchronous — awaiting Supabase calls inside
      // onAuthStateChange deadlocks. Defer state updates via setTimeout.
      if (!isActive) return
      setSession(session)
      setTimeout(() => {
        if (isActive) setLoading(false)
      }, 0)
    })

    return () => {
      isActive = false
      subscription.unsubscribe()
    }
  }, [shouldBypassAuthBootstrap])

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)
