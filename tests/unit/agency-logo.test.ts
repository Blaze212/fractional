import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getSession = vi.fn()
vi.mock('../../apps/portal/src/lib/supabase', () => ({
  supabase: { auth: { getSession: () => getSession() } },
}))

import { loadAgencyLogo } from '../../apps/portal/src/lib/agencyLogo'

const META = {
  signed_url: 'https://storage.example/logo.png?token=abc',
  mime_type: 'image/png',
  width_px: 200,
  height_px: 80,
  updated_at: '2026-01-01T00:00:00Z',
}

let createObjectURL: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cached')
})

afterEach(() => {
  vi.clearAllMocks()
  createObjectURL.mockRestore()
})

describe('loadAgencyLogo', () => {
  it('downloads the bytes once and caches them as a blob object URL', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('resume-logo')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logo: META }) })
      }
      // the signed-url byte download
      return Promise.resolve({
        ok: true,
        blob: () =>
          Promise.resolve({ arrayBuffer: () => Promise.resolve(new Uint8Array([7, 8, 9]).buffer) }),
      })
    })

    const cached = await loadAgencyLogo()

    expect(cached).not.toBeNull()
    expect(cached!.url).toBe('blob:cached')
    expect(Array.from(cached!.bytes)).toEqual([7, 8, 9])
    expect(cached!.widthPx).toBe(200)
    expect(cached!.heightPx).toBe(80)
    expect(cached!.mimeType).toBe('image/png')
    // The signed URL was fetched to get the bytes.
    expect(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])),
    ).toContain(META.signed_url)
  })

  it('returns null when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    global.fetch = vi.fn()
    expect(await loadAgencyLogo()).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns null when no logo is set', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ logo: null }) })
    expect(await loadAgencyLogo()).toBeNull()
  })
})
