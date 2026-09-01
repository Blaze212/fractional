import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../apps/bh-systems/src/worker.js'

const GAS_EXEC_URL = 'https://script.google.com/macros/s/deadbeef/exec'

function env(overrides: Record<string, unknown> = {}) {
  return { GAS_EXEC_URL, ASSETS: { fetch: vi.fn() }, ...overrides }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('proxyToAppsScript', () => {
  it('forwards the query string and POST body to GAS_EXEC_URL untouched', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('OK', { status: 200, headers: { 'content-type': 'text/xml' } }),
      )

    const request = new Request('https://worker.example/texml/gas?event=recording&t=secret', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B18176762145',
    })

    await worker.fetch(request, env())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [target] = fetchSpy.mock.calls[0]
    expect(String(target)).toBe(`${GAS_EXEC_URL}?event=recording&t=secret`)
  })

  it('does not add a retell_sig param when no X-Retell-Signature header is present', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('OK', { status: 200 }))

    const request = new Request(
      'https://worker.example/texml/gas?event=dograh_notetaker&t=secret',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    )

    await worker.fetch(request, env())

    const [target] = fetchSpy.mock.calls[0]
    expect(String(target)).not.toContain('retell_sig')
  })

  it('forwards X-Retell-Signature as a retell_sig query param, since Apps Script cannot read headers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('OK', { status: 200 }))

    const request = new Request('https://worker.example/texml/gas?event=retell&t=secret', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': 'v=1700000000000,d=abc123',
      },
      body: '{"event":"call_ended"}',
    })

    await worker.fetch(request, env())

    const [target] = fetchSpy.mock.calls[0]
    const targetUrl = new URL(String(target))
    expect(targetUrl.searchParams.get('retell_sig')).toBe('v=1700000000000,d=abc123')
    expect(targetUrl.searchParams.get('event')).toBe('retell')
    expect(targetUrl.searchParams.get('t')).toBe('secret')
  })

  it('forwards the raw request body untouched alongside the signature param', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('OK', { status: 200 }))

    const rawBody = '{"event":"call_analyzed","call":{"call_id":"call_abc"}}'
    const request = new Request('https://worker.example/texml/gas?event=retell&t=secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-retell-signature': 'v=1,d=abc' },
      body: rawBody,
    })

    await worker.fetch(request, env())

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.body).toBe(rawBody)
  })

  it('returns a clean fallback TeXML response instead of throwing when the upstream fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blip'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const request = new Request('https://worker.example/texml/gas?event=retell&t=secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-retell-signature': 'v=1,d=abc' },
      body: '{}',
    })

    const response = await worker.fetch(request, env())

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<Response>')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('serves static assets for any non-proxy path', async () => {
    const assetsFetch = vi.fn().mockResolvedValue(new Response('asset'))
    const request = new Request('https://worker.example/index.html')

    await worker.fetch(request, env({ ASSETS: { fetch: assetsFetch } }))

    expect(assetsFetch).toHaveBeenCalledTimes(1)
  })
})
