import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const FILES = ['apps/adjuster/src/core/deps.js', 'apps/adjuster/src/core/openrouter.js']

const { buildExtractionSchema } = loadGs(FILES)

/**
 * Everything the file under test reaches outside itself now arrives as
 * `deps`, so the harness builds one instead of stubbing Apps Script globals.
 * `sent` records the request core handed to deps.fetch, which is what the
 * payload assertions below read.
 */
function harness(fetchResponses: Array<{ status: number; body: string }>) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const serverLogged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const sent: Array<Record<string, any>> = []
  const slept: number[] = []
  let call = 0

  const deps = {
    fetch: (request: Record<string, any>) => {
      sent.push(request)
      const res = fetchResponses[Math.min(call, fetchResponses.length - 1)]
      call += 1
      return { status: res.status, body: res.body, headers: {} }
    },
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      logServerOnly: (event: string, fields: Record<string, unknown>) =>
        serverLogged.push({ event, fields }),
    },
    sleep: (ms: number) => slept.push(ms),
  }

  const sandbox = loadGs(FILES)

  return { sandbox, deps, logged, serverLogged, sent, slept }
}

const SPEC = {
  loss_date: { type: 'date', label: 'Loss date' },
  coverage_determination: { type: 'variant', label: 'Coverage' },
}

function everyObject(node: any, seen: any[] = []): any[] {
  if (!node || typeof node !== 'object') return seen
  if (node.type === 'object') seen.push(node)
  Object.values(node).forEach((child) => everyObject(child, seen))
  return seen
}

describe('buildExtractionSchema', () => {
  it('marks every object closed, which strict mode rejects the request without', () => {
    const objects = everyObject(buildExtractionSchema(SPEC))

    expect(objects.length).toBeGreaterThan(0)
    objects.forEach((node) => expect(node.additionalProperties).toBe(false))
  })

  it('lists every property of every object in required', () => {
    everyObject(buildExtractionSchema(SPEC)).forEach((node) => {
      expect(node.required.slice().sort()).toEqual(Object.keys(node.properties).sort())
    })
  })

  it('types every extracted value, since an untyped value is not valid under strict mode', () => {
    const schema = buildExtractionSchema(SPEC)

    Object.keys(SPEC).forEach((tag) => {
      expect(schema.properties.fields.properties[tag].properties.value).toEqual({ type: 'string' })
    })
  })

  it('requires a field entry for every tag in the template spec', () => {
    const schema = buildExtractionSchema(SPEC)

    expect(schema.properties.fields.required).toEqual(['loss_date', 'coverage_determination'])
  })

  it('allows a medium confidence tier alongside high and low', () => {
    const schema = buildExtractionSchema(SPEC)

    expect(schema.properties.fields.properties.loss_date.properties.confidence.enum).toEqual([
      'high',
      'medium',
      'low',
    ])
  })
})

describe('provider routing', () => {
  it('requires endpoints that support the requested parameters', () => {
    const src = readFileSync('apps/adjuster/src/core/openrouter.js', 'utf-8')

    expect(src).toContain('require_parameters: true')
  })
})

describe('callOpenRouter logging', () => {
  const OK_BODY = JSON.stringify({
    model: 'gpt-5.4',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content: JSON.stringify({ fields: {}, unplaced_notes: [] }) } }],
  })

  it('logs the full response body and transcript to the server log (Apps Script), not the sheet', () => {
    const { sandbox, deps, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouter({
      apiKey: 'key',
      model: 'gpt-5.4',
      deps,
      captureId: 'capture-1',
      transcript: 'roof is 3-tab, twelve years old',
      messages: [],
      jsonSchema: {},
    })

    const full = serverLogged.find((l) => l.event === 'openrouter.response')
    expect(full).toBeTruthy()
    expect(full!.fields.capture_id).toBe('capture-1')
    expect(full!.fields.status).toBe(200)
    expect(full!.fields.transcript).toBe('roof is 3-tab, twelve years old')
    expect(full!.fields.response_body).toBe(OK_BODY)

    // The sheet-bound line carries counts, not the payload itself.
    const summary = logged.find((l) => l.event === 'openrouter.response_summary')
    expect(summary).toBeTruthy()
    expect(summary!.fields.transcript_chars).toBe('roof is 3-tab, twelve years old'.length)
    expect(summary!.fields.response_chars).toBe(OK_BODY.length)
    expect(summary!.fields).not.toHaveProperty('transcript')
    expect(summary!.fields).not.toHaveProperty('response_body')
  })

  it('never logs the API key', () => {
    const { sandbox, deps, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouter({
      apiKey: 'super-secret-key',
      model: 'gpt-5.4',
      deps,
      captureId: 'capture-1',
      transcript: 'x',
      messages: [],
      jsonSchema: {},
    })

    expect(JSON.stringify(logged)).not.toContain('super-secret-key')
    expect(JSON.stringify(serverLogged)).not.toContain('super-secret-key')
  })

  it('logs each retry attempt separately, including the failing response body', () => {
    const { sandbox, deps, serverLogged } = harness([
      { status: 500, body: '{"error":"upstream down"}' },
      { status: 200, body: OK_BODY },
    ])

    sandbox.callOpenRouter({
      apiKey: 'key',
      model: 'gpt-5.4',
      deps,
      captureId: 'capture-1',
      transcript: 'x',
      messages: [],
      jsonSchema: {},
    })

    const entries = serverLogged.filter((l) => l.event === 'openrouter.response')
    expect(entries.map((e) => e.fields.attempt)).toEqual([1, 2])
    expect(entries[0].fields.status).toBe(500)
    expect(entries[0].fields.response_body).toContain('upstream down')
  })

  it('still caps the server log at a generous backstop, not the sheet-sized 45k margin', () => {
    const hugeBody = JSON.stringify({ note: 'x'.repeat(300000) })
    const { sandbox, deps, serverLogged } = harness([{ status: 200, body: hugeBody }])

    expect(() =>
      sandbox.callOpenRouter({
        apiKey: 'key',
        model: 'gpt-5.4',
        deps,
        captureId: 'capture-1',
        transcript: 'y'.repeat(300000),
        messages: [],
        jsonSchema: {},
      }),
    ).toThrow() // response body isn't valid extraction JSON, but logging happens first

    const entry = serverLogged.find((l) => l.event === 'openrouter.response')!
    expect((entry.fields.transcript as string).length).toBe(200000)
    expect((entry.fields.response_body as string).length).toBe(200000)
  })
})

describe('callOpenRouterWebSearch', () => {
  const OK_BODY = JSON.stringify({
    model: 'openai/gpt-5.4-mini:online',
    choices: [{ message: { content: '{"year_built":"1979","source_url":"https://x.com/y"}' } }],
  })

  it('appends :online to the model and sends no response_format', () => {
    const { sandbox, deps, sent } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouterWebSearch({
      apiKey: 'key',
      model: 'openai/gpt-5.4-mini',
      deps,
      messages: [{ role: 'user', content: 'Property address: 1 Main St' }],
    })

    const payload = JSON.parse(sent[0].payload)
    expect(payload.model).toBe('openai/gpt-5.4-mini:online')
    expect(payload.response_format).toBeUndefined()
    expect(payload.provider).toBeUndefined()
  })

  it('returns the raw message content for the caller to parse', () => {
    const { sandbox, deps } = harness([{ status: 200, body: OK_BODY }])

    const result = sandbox.callOpenRouterWebSearch({
      apiKey: 'key',
      model: 'openai/gpt-5.4-mini',
      deps,
      messages: [],
    })

    expect(result.content).toBe('{"year_built":"1979","source_url":"https://x.com/y"}')
    expect(result.model).toBe('openai/gpt-5.4-mini:online')
  })

  it('retries a 5xx once before succeeding, same as callOpenRouter', () => {
    const { sandbox, deps, serverLogged } = harness([
      { status: 503, body: '{"error":"upstream down"}' },
      { status: 200, body: OK_BODY },
    ])

    sandbox.callOpenRouterWebSearch({
      apiKey: 'key',
      model: 'openai/gpt-5.4-mini',
      deps,
      messages: [],
    })

    const entries = serverLogged.filter((l) => l.event === 'openrouter_web_search.response')
    expect(entries.map((e) => e.fields.attempt)).toEqual([1, 2])
  })

  it('throws after retries are exhausted rather than returning a bad result', () => {
    const { sandbox, deps } = harness([
      { status: 500, body: 'x' },
      { status: 500, body: 'x' },
      { status: 500, body: 'x' },
    ])

    expect(() =>
      sandbox.callOpenRouterWebSearch({
        apiKey: 'key',
        model: 'openai/gpt-5.4-mini',
        deps,
        messages: [],
      }),
    ).toThrow(/OpenRouter web search request failed/)
  })

  it('never logs the API key', () => {
    const { sandbox, deps, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouterWebSearch({
      apiKey: 'super-secret-key',
      model: 'openai/gpt-5.4-mini',
      deps,
      messages: [],
    })

    expect(JSON.stringify(logged)).not.toContain('super-secret-key')
    expect(JSON.stringify(serverLogged)).not.toContain('super-secret-key')
  })
})

describe('callOpenRouter generalization', () => {
  const body = JSON.stringify({
    model: 'test-model',
    choices: [
      { message: { content: JSON.stringify({ turns: [{ speaker: 'agent', text: 'hi' }] }) } },
    ],
  })

  function call(
    sandbox: Record<string, any>,
    deps: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return sandbox.callOpenRouter({
      apiKey: 'k',
      model: 'test-model',
      deps,
      captureId: 'dograh-1',
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: { type: 'object' },
      ...extra,
    })
  }

  it('defaults to the extraction schema name and the openrouter log label', () => {
    const { sandbox, deps, sent, logged, serverLogged } = harness([{ status: 200, body }])

    call(sandbox, deps)

    expect(JSON.parse(sent[0].payload).response_format.json_schema.name).toBe('extraction')
    expect(serverLogged[0].event).toBe('openrouter.response')
    expect(logged[0].event).toBe('openrouter.response_summary')
  })

  it('routes another caller under its own schema name and log label', () => {
    const { sandbox, deps, sent, logged, serverLogged } = harness([{ status: 200, body }])

    call(sandbox, deps, { schemaName: 'master_transcript', logLabel: 'master_transcript' })

    const schema = JSON.parse(sent[0].payload).response_format.json_schema
    expect(schema.name).toBe('master_transcript')
    expect(schema.strict).toBe(true)
    expect(serverLogged[0].event).toBe('master_transcript.response')
    expect(logged[0].event).toBe('master_transcript.response_summary')
  })

  it('hands the parsed body back verbatim for a non-extraction schema', () => {
    const { sandbox, deps } = harness([{ status: 200, body }])

    const result = call(sandbox, deps, { schemaName: 'master_transcript' })

    expect(result.content.turns).toEqual([{ speaker: 'agent', text: 'hi' }])
    expect(result.model).toBe('test-model')
  })
})

// The injection point itself, asserted rather than assumed: a call that lost
// its HTTP client must be an error at the boundary, not a silent skip that
// returns an empty extraction reading as a bad call.
describe('injected dependencies', () => {
  const OK_BODY = JSON.stringify({
    model: 'm',
    choices: [{ message: { content: JSON.stringify({ fields: {}, unplaced_notes: [] }) } }],
  })

  it('throws when no deps.fetch is supplied', () => {
    const { sandbox } = harness([{ status: 200, body: OK_BODY }])

    expect(() =>
      sandbox.callOpenRouter({ apiKey: 'k', model: 'm', messages: [], jsonSchema: {} }),
    ).toThrow(/deps\.fetch is required/)
  })

  it('lets a failing injected fetch surface rather than swallowing it', () => {
    const { sandbox } = harness([{ status: 200, body: OK_BODY }])
    const deps = {
      fetch: () => {
        throw new Error('socket hang up')
      },
    }

    expect(() =>
      sandbox.callOpenRouter({ apiKey: 'k', model: 'm', deps, messages: [], jsonSchema: {} }),
    ).toThrow(/socket hang up/)
  })

  it('backs off through deps.sleep between retries, never a runtime global', () => {
    const { sandbox, deps, slept } = harness([
      { status: 500, body: 'down' },
      { status: 500, body: 'down' },
      { status: 200, body: OK_BODY },
    ])

    sandbox.callOpenRouter({ apiKey: 'k', model: 'm', deps, messages: [], jsonSchema: {} })

    expect(slept).toEqual([5000, 15000])
  })

  it('logs through deps.logger, so a core file never reaches log.js directly', () => {
    const { sandbox, deps, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouter({ apiKey: 'k', model: 'm', deps, messages: [], jsonSchema: {} })

    expect(logged.map((l) => l.event)).toEqual(['openrouter.response_summary'])
    expect(serverLogged.map((l) => l.event)).toEqual(['openrouter.response'])
  })

  it('tolerates a deps with no logger at all', () => {
    const { sandbox } = harness([{ status: 200, body: OK_BODY }])
    const deps = { fetch: () => ({ status: 200, body: OK_BODY, headers: {} }) }

    expect(() =>
      sandbox.callOpenRouter({ apiKey: 'k', model: 'm', deps, messages: [], jsonSchema: {} }),
    ).not.toThrow()
  })
})
