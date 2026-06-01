import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { loadAgencyLogo } from '../lib/agencyLogo'
import type { CachedLogo } from '../lib/agencyLogo'

interface AgencyLogoContextValue {
  logo: CachedLogo | null
  loading: boolean
  refreshLogo: () => Promise<void>
  clearLogo: () => void
}

const AgencyLogoContext = createContext<AgencyLogoContextValue | null>(null)

export function AgencyLogoProvider({ children }: { children: React.ReactNode }) {
  const [logo, setLogo] = useState<CachedLogo | null>(null)
  const [loading, setLoading] = useState(true)
  const currentUrl = useRef<string | null>(null)

  // Swap in a new cached logo, revoking the previous object URL to avoid leaks.
  const apply = useCallback((next: CachedLogo | null) => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    currentUrl.current = next?.url ?? null
    setLogo(next)
  }, [])

  const refreshLogo = useCallback(async () => {
    apply(await loadAgencyLogo())
    setLoading(false)
  }, [apply])

  const clearLogo = useCallback(() => apply(null), [apply])

  useEffect(() => {
    void refreshLogo()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        void refreshLogo()
      } else {
        apply(null)
        setLoading(false)
      }
    })

    return () => {
      subscription.unsubscribe()
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    }
  }, [refreshLogo, apply])

  return (
    <AgencyLogoContext.Provider value={{ logo, loading, refreshLogo, clearLogo }}>
      {children}
    </AgencyLogoContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAgencyLogo(): AgencyLogoContextValue {
  const ctx = useContext(AgencyLogoContext)
  if (!ctx) throw new Error('useAgencyLogo must be used within AgencyLogoProvider')
  return ctx
}
