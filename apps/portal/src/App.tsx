import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { AgencyConfigProvider } from './contexts/AgencyConfigContext'
import { AgencyLogoProvider } from './contexts/AgencyLogoContext'
import { ProtectedRoute } from './components/ProtectedRoute'

const LoginPage = lazy(() => import('./pages/LoginPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const UpdatePasswordPage = lazy(() => import('./pages/UpdatePasswordPage'))
const ResumeTemplaterPage = lazy(() => import('./pages/ResumeTemplaterPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="border-brand h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
    </div>
  )
}

export default function App() {
  return (
    <AgencyConfigProvider>
      <AuthProvider>
        <AgencyLogoProvider>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* Public auth routes */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/update-password" element={<UpdatePasswordPage />} />

              {/* Protected routes */}
              <Route element={<ProtectedRoute />}>
                <Route path="/resume-templater" element={<ResumeTemplaterPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              {/* Default redirect */}
              <Route path="/" element={<Navigate to="/resume-templater" replace />} />
              <Route path="*" element={<Navigate to="/resume-templater" replace />} />
            </Routes>
          </Suspense>
        </AgencyLogoProvider>
      </AuthProvider>
    </AgencyConfigProvider>
  )
}
