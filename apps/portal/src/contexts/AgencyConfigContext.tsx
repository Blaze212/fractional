import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { AGENCY_CONFIG } from '../lib/agencyConfig'
import type { AgencyConfig } from '../lib/agencyConfig'

const STORAGE_KEY = 'agency_config'

// Exported so SettingsPage can call it for live color preview without saving.
// eslint-disable-next-line react-refresh/only-export-components
export function applyBrandCssVars(brand: AgencyConfig['brand']) {
  const root = document.documentElement
  root.style.setProperty('--color-brand', brand.primary)
  root.style.setProperty('--color-brand-light', brand.primaryLight)
  root.style.setProperty('--color-brand-secondary', brand.secondary)
  root.style.setProperty('--color-brand-muted', brand.muted)
}

function mergeWithDefaults(partial: Partial<AgencyConfig>): AgencyConfig {
  return {
    identity: { ...AGENCY_CONFIG.identity, ...partial.identity },
    brand: { ...AGENCY_CONFIG.brand, ...partial.brand },
    export: { ...AGENCY_CONFIG.export, ...partial.export },
    llm: { ...AGENCY_CONFIG.llm, ...partial.llm },
  }
}

function loadFromCache(): AgencyConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? mergeWithDefaults(JSON.parse(stored) as Partial<AgencyConfig>) : AGENCY_CONFIG
  } catch {
    return AGENCY_CONFIG
  }
}

interface AgencyConfigContextValue {
  config: AgencyConfig
  loading: boolean
  saveConfig: (next: AgencyConfig) => Promise<void>
  resetConfig: () => Promise<void>
}

const AgencyConfigContext = createContext<AgencyConfigContextValue | null>(null)

export function AgencyConfigProvider({ children }: { children: React.ReactNode }) {
  // Initialise from localStorage so there's no flash on load
  const [config, setConfig] = useState<AgencyConfig>(loadFromCache)
  const [loading, setLoading] = useState(true)

  // Apply CSS vars whenever config.brand changes
  useEffect(() => {
    applyBrandCssVars(config.brand)
  }, [config.brand])

  // Sync from DB whenever auth state changes
  useEffect(() => {
    async function fetchFromDb(userId: string) {
      const { data } = await supabase
        .from('user_agency_configs')
        .select('config')
        .eq('user_id', userId)
        .maybeSingle()

      if (data?.config) {
        const merged = mergeWithDefaults(data.config as Partial<AgencyConfig>)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
        setConfig(merged)
      }
      setLoading(false)
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        void fetchFromDb(session.user.id)
        return
      }
      // Only an explicit sign-out should drop the cached config and revert to
      // defaults. INITIAL_SESSION with no user (public pages like /login, or any
      // moment before the session resolves) must keep the cached brand applied —
      // otherwise saved colors are wiped and never apply outside the auth flow.
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem(STORAGE_KEY)
        setConfig(AGENCY_CONFIG)
      }
      setLoading(false)
    })

    // Also fetch immediately if already signed in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        void fetchFromDb(session.user.id)
      } else {
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const saveConfig = useCallback(async (next: AgencyConfig) => {
    // Write-through cache: update UI immediately, persist to DB in background
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setConfig(next)

    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) return

    await supabase.from('user_agency_configs').upsert({
      user_id: session.user.id,
      config: next,
      updated_at: new Date().toISOString(),
    })
  }, [])

  const resetConfig = useCallback(async () => {
    localStorage.removeItem(STORAGE_KEY)
    setConfig(AGENCY_CONFIG)

    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) return

    await supabase.from('user_agency_configs').delete().eq('user_id', session.user.id)
  }, [])

  return (
    <AgencyConfigContext.Provider value={{ config, loading, saveConfig, resetConfig }}>
      {children}
    </AgencyConfigContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAgencyConfig(): AgencyConfigContextValue {
  const ctx = useContext(AgencyConfigContext)
  if (!ctx) throw new Error('useAgencyConfig must be used within AgencyConfigProvider')
  return ctx
}
