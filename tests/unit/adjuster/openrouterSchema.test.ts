import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const { buildExtractionSchema } = loadGs('apps/adjuster/src/llm/openrouter.js')

function harness(fetchResponses: Array<{ status: number; body: string }>) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const serverLogged: Array<{ event: string; fields: Record<string, unknown> }> = []
  let call = 0

  const sandbox = loadGs('apps/adjuster/src/llm/openrouter.js', {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    logServerOnly: (event: string, fields: Record<string, unknown>) =>
      serverLogged.push({ event, fields }),
    UrlFetchApp: {
      fetch: () => {
        const res = fetchResponses[Math.min(call, fetchResponses.length - 1)]
        call += 1
        return { getResponseCode: () => res.status, getContentText: () => res.body }
      },
    },
    Utilities: { sleep: () => {} },
  })

  return { sandbox, logged, serverLogged }
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
    const src = readFileSync('apps/adjuster/src/llm/openrouter.js', 'utf-8')

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
    const { sandbox, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouter({
      apiKey: 'key',
      model: 'gpt-5.4',
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
    const { sandbox, logged, serverLogged } = harness([{ status: 200, body: OK_BODY }])

    sandbox.callOpenRouter({
      apiKey: 'super-secret-key',
      model: 'gpt-5.4',
      captureId: 'capture-1',
      transcript: 'x',
      messages: [],
      jsonSchema: {},
    })

    expect(JSON.stringify(logged)).not.toContain('super-secret-key')
    expect(JSON.stringify(serverLogged)).not.toContain('super-secret-key')
  })

  it('logs each retry attempt separately, including the failing response body', () => {
    const { sandbox, serverLogged } = harness([
      { status: 500, body: '{"error":"upstream down"}' },
      { status: 200, body: OK_BODY },
    ])

    sandbox.callOpenRouter({
      apiKey: 'key',
      model: 'gpt-5.4',
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
    const { sandbox, serverLogged } = harness([{ status: 200, body: hugeBody }])

    expect(() =>
      sandbox.callOpenRouter({
        apiKey: 'key',
        model: 'gpt-5.4',
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
