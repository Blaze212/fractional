import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAgencyLogo } from '../contexts/AgencyLogoContext'

async function getToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.access_token
}

export function LogoUploader({ disabled = false }: { disabled?: boolean }) {
  const { logo, setLogo, refreshLogo } = useAgencyLogo()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)
    setUploading(true)

    try {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image()
        const url = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: img.naturalWidth, height: img.naturalHeight })
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('Failed to load image'))
        }
        img.src = url
      })

      const form = new FormData()
      form.append('file', file)
      form.append('width', String(dimensions.width))
      form.append('height', String(dimensions.height))

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}` },
        body: form,
      })

      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } }
        throw new Error(err.error?.message ?? 'Upload failed')
      }

      await refreshLogo()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemove() {
    setError(null)
    setUploading(true)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/resume-logo`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await getToken()}` },
      })
      if (!res.ok) throw new Error('Remove failed')
      setLogo(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-700">Agency Logo</label>
      <div className="flex items-center gap-4">
        {logo ? (
          <>
            <img
              src={logo.signed_url}
              alt="Agency logo"
              className="h-12 max-w-[120px] rounded border border-slate-200 object-contain"
            />
            <button
              type="button"
              onClick={handleRemove}
              disabled={disabled || uploading}
              className="text-sm text-red-500 hover:text-red-700 disabled:opacity-50"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
              className="text-brand text-sm hover:underline disabled:opacity-50"
            >
              Replace
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            className="hover:border-brand hover:text-brand rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500 disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '+ Add logo (PNG/JPEG, max 2 MB)'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  )
}
