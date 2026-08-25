export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/texml/gas') {
      return proxyToAppsScript(request, url, env)
    }

    return env.ASSETS.fetch(request)
  },
}

// Apps Script's /exec endpoint always answers with a 302 to a
// script.googleusercontent.com URL carrying the real body — that's
// unconditional Apps Script behavior, not a misconfiguration. Telnyx's
// TeXML Redirect/action/callback targets don't follow that hop, so a call
// routed straight at script.google.com errors out with no usable response.
// fetch() here follows the redirect server-side (its default behavior) and
// hands Telnyx one definitive response instead.
async function proxyToAppsScript(request, url, env) {
  try {
    // Constructing the target URL can throw just as easily as the fetch can
    // (e.g. GAS_EXEC_URL unset or not a full absolute URL) — it has to be
    // inside this try, or a bad secret crashes the whole Worker invocation
    // (Cloudflare error 1101) instead of hitting the fallback below.
    const target = new URL(env.GAS_EXEC_URL)
    target.search = url.search

    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        'content-type': request.headers.get('content-type') || 'application/x-www-form-urlencoded',
      },
      body: request.method === 'POST' ? await request.text() : undefined,
    })

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'text/xml' },
    })
  } catch (err) {
    // Apps Script cold start / timeout / network blip / bad GAS_EXEC_URL:
    // leave the caller with a clean hangup instead of an "Application error",
    // but still surface the failure — visible via `wrangler tail` or the
    // Workers Logs tab in the Cloudflare dashboard, since nothing else here
    // reports a proxy failure anywhere.
    console.error('texml/gas proxy failed:', String(err))
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Telnyx.Natural.brook">' +
        'Sorry, something went wrong on our end. Please call back.</Say><Hangup/></Response>',
      { status: 200, headers: { 'content-type': 'text/xml' } },
    )
  }
}
