import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

// core.run end to end against stub deps: two source transcripts in, a merged
// master, an extraction, and a validated field map out — with no Apps Script
// global seeded and no network reachable.
//
// This is the test that says the boundary actually works. Everything the
// pipeline needs arrives as an argument (config, tagSchema, glossary,
// liveFields) or through deps (fetch, logger). If a step were still reaching
// for PropertiesService, enums.json, or log.js, it would fail here as a
// ReferenceError rather than passing on a stub someone remembered to write.

// index.js last: loadGs runs each file as its own vm script, so the `core`
// object's initialiser only sees functions from files already loaded. Apps
// Script concatenates every file into one script and hoists across all of them,
// which is why this ordering constraint exists here and not in production.
const CORE_FILES = [
  'apps/adjuster/src/core/deps.js',
  'apps/adjuster/src/core/matcher.js',
  'apps/adjuster/src/core/llmMatcher.js',
  'apps/adjuster/src/core/prompt.js',
  'apps/adjuster/src/core/openrouter.js',
  'apps/adjuster/src/core/masterTranscript.js',
  'apps/adjuster/src/core/transcription.js',
  'apps/adjuster/src/core/validate.js',
  'apps/adjuster/src/core/pipeline.js',
  'apps/adjuster/src/core/index.js',
]

const TAG_SCHEMA = {
  contacted_party_name: { label: 'Contacted party', type: 'string', required: true },
  roof_covering_type: { label: 'Roof covering', type: 'string', required: false },
  // Required, so a value with no usable span lands on NEEDS INPUT rather than
  // being quietly omitted — which is the state the claim-property backstop
  // exists to rescue.
  year_built: { label: 'Year built', type: 'string', required: true },
}

const GLOSSARY = [{ term: 'drip edge', definition: 'metal edge flashing' }]

const SPOKEN = 'I met with Dale Henderson at the property and the roof is three tab asphalt shingle'

const SOURCES = {
  elevenlabs: { text: SPOKEN },
  qwen: { text: 'I met with Dale Henderson at the property and the roof is 3-tab asphalt shingle' },
  dograh: { text: 'I met with Dale Anderson at the property and the ruf is three tab asphalt' },
}

const CLAIM = {
  claim_id: 'claim-1',
  insured_last_name: 'Henderson',
  address_line1: '412 Dare Dr',
  city: 'Concord',
  claim_number: 'CLF-9921',
  property_year_built: 1978,
}

/** An OpenRouter chat-completions body carrying `content` as its message. */
function openRouterBody(content: unknown, model = 'test-model') {
  return JSON.stringify({
    model,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content: JSON.stringify(content) } }],
  })
}

const MERGE_RESPONSE = openRouterBody({
  turns: [{ speaker: 'adjuster', text: SPOKEN }],
  contested_passages: [],
})

const EXTRACTION_RESPONSE = openRouterBody({
  fields: {
    contacted_party_name: {
      value: 'Dale Henderson',
      source_span: 'I met with Dale Henderson at the property',
      confidence: 'high',
    },
    roof_covering_type: {
      value: 'three tab asphalt shingle',
      source_span: 'the roof is three tab asphalt shingle',
      confidence: 'high',
    },
    // No span anywhere in the transcript. The span check has to reject it, and
    // the claim-property backstop has to fill it from the Claims row instead.
    year_built: { value: '1978', source_span: '', confidence: 'high' },
  },
  unplaced_notes: ['homeowner mentioned a prior claim'],
})

/**
 * Replays recorded OpenRouter responses, dispatched on the schema name in the
 * request the caller built. Deterministic, and it never dials anything.
 */
function harness(responses: Partial<Record<string, string>> = {}) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const requests: Array<Record<string, any>> = []

  const bodies: Record<string, string> = {
    master_transcript: MERGE_RESPONSE,
    extraction: EXTRACTION_RESPONSE,
    ...responses,
  }

  const deps = {
    fetch: (request: Record<string, any>) => {
      requests.push(request)
      const payload = JSON.parse(request.payload)
      const schema = payload.response_format?.json_schema?.name ?? 'extraction'
      const body = bodies[schema]
      if (body === undefined) throw new Error('no recorded response for schema ' + schema)
      return { status: 200, body, headers: {} }
    },
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      logServerOnly: () => {},
    },
    sleep: () => {},
  }

  const sandbox = loadGs(CORE_FILES)

  return { sandbox, core: sandbox.core, deps, logged, requests }
}

function run(sandbox: Record<string, any>, deps: unknown, overrides: Record<string, unknown> = {}) {
  return sandbox.core.run({
    captureId: 'dograh-1',
    callStartedAt: '2026-08-26T18:00:00Z',
    sources: SOURCES,
    claim: CLAIM,
    claims: [CLAIM],
    tagSchema: TAG_SCHEMA,
    glossary: GLOSSARY,
    liveFields: null,
    config: { apiKey: 'k', model: 'm', fallbacks: [], adjusterName: 'Brandon' },
    deps,
    ...overrides,
  })
}

describe('core.run', () => {
  it('returns a validated field map, the master, and the manifest', () => {
    const { sandbox, deps } = harness()

    const result = run(sandbox, deps)

    expect(result.match.claim_id).toBe('claim-1')
    expect(result.master.accepted).toBe(true)
    expect(result.validated.contacted_party_name).toMatchObject({
      valid: true,
      value: 'Dale Henderson',
    })
    expect(result.validated.roof_covering_type).toMatchObject({
      valid: true,
      value: 'three tab asphalt shingle',
    })
    expect(result.manifest.extraction_input).toBe('master')
    expect(result.manifest.master_accepted).toBe(true)
  })

  it('rejects a field whose span is not in the transcript, and lets a backstop fill it', () => {
    const { sandbox, deps } = harness()

    const result = run(sandbox, deps)

    // The model asserted 1978 with no span. validateFields refuses it; the
    // Claims row's public-records lookup supplies it instead, and says so.
    expect(result.validated.year_built).toMatchObject({
      valid: true,
      value: '1978',
      confidence: 'claim',
    })
  })

  it('never reaches for an Apps Script global, a config file, or a logger', () => {
    const { sandbox } = harness()

    // loadGs seeds `console` and nothing else, so these would exist only if
    // some core file had defined them.
    ;['PropertiesService', 'DriveApp', 'UrlFetchApp', 'logEvent', 'loadEnums'].forEach((name) =>
      expect(sandbox[name]).toBeUndefined(),
    )
  })

  it('spends exactly two vendor calls: one merge, one extraction', () => {
    const { sandbox, deps, requests } = harness()

    run(sandbox, deps)

    expect(requests).toHaveLength(2)
    expect(requests.map((r) => JSON.parse(r.payload).response_format.json_schema.name)).toEqual([
      'master_transcript',
      'extraction',
    ])
  })

  it('logs the whole run through deps.logger', () => {
    const { sandbox, deps, logged } = harness()

    run(sandbox, deps)

    expect(logged.map((l) => l.event)).toEqual(
      expect.arrayContaining(['runner.extracted', 'runner.validated']),
    )
  })

  it('carries a live export in as a cross-check hint rather than as an answer', () => {
    const { sandbox, deps, requests } = harness()

    run(sandbox, deps, { liveFields: { roof_covering_type: 'architectural shingle' } })

    const extraction = requests[1]
    expect(JSON.parse(extraction.payload).messages[1].content).toContain('architectural shingle')
  })

  it('falls back to the highest-precedence raw source when the merge is rejected', () => {
    // Every phrase authored rather than selected, so verbatim coverage is zero.
    const { sandbox, deps } = harness({
      master_transcript: openRouterBody({
        turns: [{ speaker: 'adjuster', text: 'a completely different sentence about nothing' }],
        contested_passages: [],
      }),
    })

    const result = run(sandbox, deps)

    expect(result.master.accepted).toBe(false)
    expect(result.manifest.extraction_input).toBe('elevenlabs')
  })

  it('degrades to a raw source when the merge call itself fails', () => {
    const { sandbox, deps, logged } = harness()
    const failing = Object.assign({}, deps, {
      fetch: (request: Record<string, any>) => {
        const payload = JSON.parse(request.payload)
        if (payload.response_format.json_schema.name === 'master_transcript') {
          throw new Error('merge vendor is down')
        }
        return deps.fetch(request)
      },
    })

    const result = run(sandbox, failing)

    expect(result.master).toBeNull()
    expect(result.manifest.extraction_input).toBe('elevenlabs')
    expect(result.validated.contacted_party_name.valid).toBe(true)
    expect(logged.map((l) => l.event)).toContain('master_transcript.call_failed')
  })

  it('matches the claim itself when none was handed in', () => {
    const { sandbox, deps } = harness()

    const result = run(sandbox, deps, { claim: null })

    expect(result.match.claim_id).toBe('claim-1')
    expect(result.match.match_method).not.toBe('given')
  })
})
