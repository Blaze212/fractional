import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAgencyLogo } from '../lib/agencyLogo'
import type { LogoInfo } from '../lib/agencyLogo'

interface AgencyLogoContextValue {
  logo: LogoInfo
  loading: boolean
  setLogo: (logo: LogoInfo) => void
  refreshLogo: () => Promise<void>
}

const AgencyLogoContext = createContext<AgencyLogoContextValue | null>(null)

export function AgencyLogoProvider({ children }: { children: React.ReactNode }) {
  const [logo, setLogo] = useState<LogoInfo>(null)
  const [loading, setLoading] = useState(true)

  const refreshLogo = useCallback(async () => {
    setLogo(await fetchAgencyLogo())
    setLoading(false)
  }, [])

  useEffect(() => {
    void refreshLogo()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        void refreshLogo()
      } else {
        setLogo(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [refreshLogo])

  return (
    <AgencyLogoContext.Provider value={{ logo, loading, setLogo, refreshLogo }}>
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
