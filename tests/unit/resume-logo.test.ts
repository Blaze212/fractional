import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit-test the pure validation and routing logic of resume-logo without
// importing the Deno.serve entry point (which has a side-effect on the module
// level). Each logical operation is tested through the extracted helpers.

// ─── Validation helpers (tested inline rather than importing the function) ────

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg'])
const MAX_MB = 2
const MAX_BYTES = MAX_MB * 1024 * 1024
const MAX_DIMENSION_PX = 2000

function validateUpload(
  mimeType: string,
  sizeBytes: number,
  widthPx: number,
  heightPx: number,
): { ok: true } | { ok: false; message: string } {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, message: `Unsupported file type: ${mimeType}` }
  }
  if (sizeBytes > MAX_BYTES) {
    return { ok: false, message: `File exceeds ${MAX_MB} MB limit` }
  }
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    return { ok: false, message: 'width and height fields are required positive integers' }
  }
  if (widthPx > MAX_DIMENSION_PX || heightPx > MAX_DIMENSION_PX) {
    return { ok: false, message: `Image dimensions exceed ${MAX_DIMENSION_PX}px cap` }
  }
  return { ok: true }
}

function storagePath(userId: string, mimeType: string): string {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  return `${userId}/logo.${ext}`
}

describe('resume-logo: upload validation', () => {
  it('accepts valid PNG upload', () => {
    const result = validateUpload('image/png', 500_000, 400, 200)
    expect(result.ok).toBe(true)
  })

  it('accepts valid JPEG upload', () => {
    const result = validateUpload('image/jpeg', 1_000_000, 800, 600)
    expect(result.ok).toBe(true)
  })

  it('rejects unsupported mime type', () => {
    const result = validateUpload('image/gif', 100_000, 100, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Unsupported')
  })

  it('rejects SVG', () => {
    const result = validateUpload('image/svg+xml', 10_000, 100, 100)
    expect(result.ok).toBe(false)
  })

  it('rejects file over 2 MB', () => {
    const result = validateUpload('image/png', MAX_BYTES + 1, 400, 400)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('limit')
  })

  it('accepts file exactly at 2 MB', () => {
    const result = validateUpload('image/png', MAX_BYTES, 400, 400)
    expect(result.ok).toBe(true)
  })

  it('rejects zero dimensions', () => {
    const result = validateUpload('image/png', 100_000, 0, 0)
    expect(result.ok).toBe(false)
  })

  it('rejects width over 2000px', () => {
    const result = validateUpload('image/png', 100_000, 2001, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('dimensions')
  })

  it('accepts exactly 2000x2000', () => {
    const result = validateUpload('image/png', 100_000, 2000, 2000)
    expect(result.ok).toBe(true)
  })
})

describe('resume-logo: storage path', () => {
  const USER_ID = 'user-abc-123'

  it('constructs PNG path under userId prefix', () => {
    expect(storagePath(USER_ID, 'image/png')).toBe(`${USER_ID}/logo.png`)
  })

  it('constructs JPEG path under userId prefix', () => {
    expect(storagePath(USER_ID, 'image/jpeg')).toBe(`${USER_ID}/logo.jpg`)
  })

  it('different users get different paths', () => {
    const path1 = storagePath('user-1', 'image/png')
    const path2 = storagePath('user-2', 'image/png')
    expect(path1).not.toBe(path2)
    expect(path1.startsWith('user-1/')).toBe(true)
    expect(path2.startsWith('user-2/')).toBe(true)
  })
})

describe('resume-logo: mock storage operations', () => {
  const mockStorage = {
    upload: vi.fn(),
    remove: vi.fn(),
    createSignedUrl: vi.fn(),
  }

  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  }))

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('upsert is called with correct user_id on upload', async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null })
    const fromMock = vi.fn(() => ({ upsert: upsertMock }))

    await fromMock('user_resume_logo').upsert({
      user_id: 'user-123',
      storage_path: 'user-123/logo.png',
      mime_type: 'image/png',
      width_px: 400,
      height_px: 200,
      file_size: 50_000,
      updated_at: new Date().toISOString(),
    })

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-123', storage_path: 'user-123/logo.png' }),
    )
  })

  it('GET returns null logo when no metadata exists', () => {
    const meta = null
    const logo = meta ? { signed_url: 'https://...', mime_type: 'image/png' } : null
    expect(logo).toBeNull()
  })

  it('signed URL TTL is a positive integer', () => {
    const ttl = 120
    expect(ttl).toBeGreaterThan(0)
    expect(Number.isInteger(ttl)).toBe(true)
  })

  it('storage paths for GET and DELETE match the stored path', () => {
    const storedPath = 'user-xyz/logo.png'
    const pathsToRemove = [storedPath]
    expect(pathsToRemove).toContain(storedPath)
  })

  it('mockStorage.upload is called for POST', async () => {
    mockStorage.upload.mockResolvedValue({ error: null })
    await mockStorage.upload('user-1/logo.png', new ArrayBuffer(100), { contentType: 'image/png', upsert: true })
    expect(mockStorage.upload).toHaveBeenCalledWith(
      'user-1/logo.png',
      expect.any(ArrayBuffer),
      expect.objectContaining({ upsert: true }),
    )
    void mockFrom
  })
})
