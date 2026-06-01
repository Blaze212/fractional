import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { AgencyLogoMark } from './AgencyLogoMark'

// Shared header used across the authenticated pages: agency logo (links home)
// on the left, navigation on the right. `maxWidthClass` keeps the header's
// inner content aligned with each page's main column.
export function AppHeader({ maxWidthClass = 'max-w-3xl' }: { maxWidthClass?: string }) {
  return (
    <header className="border-b border-slate-200 bg-white px-6 py-4">
      <div className={`mx-auto flex items-center justify-between ${maxWidthClass}`}>
        <Link to="/resume-templater" aria-label="Home">
          <AgencyLogoMark />
        </Link>
        <nav className="flex items-center gap-4">
          <Link to="/settings" className="text-sm text-slate-500 hover:text-slate-700">
            Settings
          </Link>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Sign out
          </button>
        </nav>
      </div>
    </header>
  )
}
