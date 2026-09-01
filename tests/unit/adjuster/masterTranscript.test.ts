import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

const FILES = [
  'apps/adjuster/src/transcription.js',
  'apps/adjuster/src/prompt.js',
  'apps/adjuster/src/llm/masterTranscript.js',
]

function harness(overrides: Record<string, unknown> = {}) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const calls: Record<string, unknown>[] = []

  const sandbox = loadGs(FILES, {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    logServerOnly: () => {},
    describeError: (err: Error) => ({ error: String(err.message ?? err), stack: '' }),
    getConfig: () => 'x',
    getOptionalConfig: (_key: string, fallback: string) => fallback,
    getConfigList: () => [],
    DriveApp: {},
    Utilities: {},
    UrlFetchApp: {},
    callOpenRouter: vi.fn((config: Record<string, unknown>) => {
      calls.push(config)
      return { content: { turns: [], contested_passages: [] }, model: 'test-model' }
    }),
    ...overrides,
  })

  return { sandbox, logged, calls }
}

function sources(overrides: Record<string, { text: string; turns?: unknown[] }> = {}) {
  return {
    elevenlabs: { text: 'the roof is a six twelve with a damaged drip edge on the front slope' },
    qwen: { text: 'the roof is a 6/12 with a damaged drip edge on the front slope' },
    dograh: { text: 'the ruf is a six twelve with a damaged drip hedge on the front slope' },
    ...overrides,
  }
}

describe('buildMasterTranscriptPrompt', () => {
  it('states the precedence order and the verbatim constraint as an absolute', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources(),
      claim: { insured_last_name: 'Henderson' },
      glossary: [{ term: 'drip edge', definition: 'metal edge flashing' }],
      adjusterName: 'Brandon',
    })

    expect(prompt.system).toContain(
      "ElevenLabs first, Qwen second, the call platform's live transcript last",
    )
    expect(prompt.system).toContain('character for character')
    expect(prompt.system).toContain('You may not write a single word')
    expect(prompt.system).not.toContain('Dograh')
  })

  it('labels all three transcripts, in precedence order', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources(),
      claim: null,
      glossary: [],
    })

    const order = [
      'ElevenLabs Scribe v2',
      'Qwen3 ASR Flash',
      "The call platform's own real-time transcript",
    ].map((label) => prompt.user.indexOf(label))
    expect(order.every((index) => index > -1)).toBe(true)
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
  })

  it('describes the third source identically for a retell precedence', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources({ retell: sources().dograh }),
      precedence: ['elevenlabs', 'qwen', 'retell'],
      claim: null,
      glossary: [],
    })

    expect(prompt.user).toContain("The call platform's own real-time transcript")
    expect(prompt.user).not.toContain('Dograh')
  })

  it('renders ElevenLabs as diarized turns when it produced a words array', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources({
        elevenlabs: {
          text: 'flat text',
          turns: [
            { speaker: 'speaker_0', text: 'the roof is a six twelve' },
            { speaker: 'speaker_1', text: 'got it' },
          ],
        },
      }),
      claim: null,
      glossary: [],
    })

    expect(prompt.user).toContain('speaker_0: the roof is a six twelve')
    expect(prompt.user).toContain('speaker_1: got it')
    expect(prompt.user).not.toContain('flat text')
  })

  it('omits a source that produced nothing rather than sending an empty block', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources({ qwen: { text: '' } }),
      claim: null,
      glossary: [],
    })

    expect(prompt.user).not.toContain('Qwen3 ASR Flash')
    expect(prompt.user).toContain('ElevenLabs Scribe v2')
    expect(prompt.user).toContain("The call platform's own real-time transcript")
  })

  it('works down to a single source', () => {
    const { sandbox } = harness()

    const prompt = sandbox.buildMasterTranscriptPrompt({
      sources: sources({ elevenlabs: { text: '' }, qwen: { text: '' } }),
      claim: null,
      glossary: [],
    })

    expect(prompt.user).toContain("The call platform's own real-time transcript")
    expect(prompt.user).not.toContain('ElevenLabs Scribe v2')
  })
})

describe('buildMasterTranscriptSchema', () => {
  it('is strict-mode shaped and constrains speaker to the two known roles', () => {
    const { sandbox } = harness()

    const schema = sandbox.buildMasterTranscriptSchema()

    expect(schema.required).toEqual(['turns', 'contested_passages'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.turns.items.required).toEqual(['speaker', 'text'])
    expect(schema.properties.turns.items.additionalProperties).toBe(false)
    expect(schema.properties.turns.items.properties.speaker.enum).toEqual(['adjuster', 'agent'])
  })
})

describe('buildMasterTranscript', () => {
  it('reuses callOpenRouter under its own schema name and log label', () => {
    const { sandbox, calls } = harness({
      callOpenRouter: vi.fn((config: Record<string, unknown>) => {
        calls.push(config)
        return {
          content: {
            turns: [{ speaker: 'adjuster', text: 'the roof is a six twelve' }],
            contested_passages: ['drip edge'],
          },
          model: 'test-model',
        }
      }),
    })

    const result = sandbox.buildMasterTranscript({
      apiKey: 'k',
      model: 'm',
      captureId: 'dograh-1',
      sources: sources(),
      claim: null,
      glossary: [],
    })

    expect(calls[0].schemaName).toBe('master_transcript')
    expect(calls[0].logLabel).toBe('master_transcript')
    expect(result.turns).toEqual([{ speaker: 'adjuster', text: 'the roof is a six twelve' }])
    expect(result.contested_passages).toEqual(['drip edge'])
  })

  it('drops empty turns and pins an unrecognised speaker to the adjuster', () => {
    const { sandbox, calls } = harness({
      callOpenRouter: vi.fn((config: Record<string, unknown>) => {
        calls.push(config)
        return {
          content: {
            turns: [
              { speaker: 'adjuster', text: '  ' },
              { speaker: 'narrator', text: ' the roof ' },
            ],
            contested_passages: [],
          },
          model: 'test-model',
        }
      }),
    })

    const result = sandbox.buildMasterTranscript({ captureId: 'x', sources: sources() })

    expect(result.turns).toEqual([{ speaker: 'adjuster', text: 'the roof' }])
  })

  it('caps contested_passages at 25 and logs the truncation', () => {
    const passages = Array.from({ length: 40 }, (_, i) => 'passage ' + i)
    const { sandbox, logged } = harness({
      callOpenRouter: () => ({
        content: { turns: [{ speaker: 'adjuster', text: 'x' }], contested_passages: passages },
        model: 'test-model',
      }),
    })

    const result = sandbox.buildMasterTranscript({ captureId: 'x', sources: sources() })

    expect(result.contested_passages).toHaveLength(25)
    expect(logged.map((l) => l.event)).toContain('master_transcript.contested_truncated')
  })
})

describe('checkVerbatimCoverage', () => {
  const source = {
    elevenlabs: { text: 'the roof is a six twelve with a damaged drip edge on the front slope' },
    qwen: { text: 'there is hail bruising across the back slope of the roof as well' },
  }

  it('returns 1.0 for a master assembled purely from source substrings', () => {
    const { sandbox } = harness()

    const result = sandbox.checkVerbatimCoverage(
      [
        { speaker: 'adjuster', text: 'the roof is a six twelve with a damaged drip edge' },
        { speaker: 'adjuster', text: 'hail bruising across the back slope of the roof as well' },
      ],
      source,
    )

    expect(result.coverage).toBe(1)
    expect(result.failing).toEqual([])
  })

  it('scores each turn on its own so a source switch between turns costs nothing', () => {
    const { sandbox } = harness()

    // Every 8-word window spanning the two turns exists in no single source.
    // Concatenating before shingling would fail seven of them.
    const result = sandbox.checkVerbatimCoverage(
      [
        { speaker: 'adjuster', text: 'a six twelve with a damaged drip edge' },
        { speaker: 'agent', text: 'hail bruising across the back slope of the' },
      ],
      source,
    )

    expect(result.total).toBe(2)
    expect(result.coverage).toBe(1)
  })

  it('ignores case and whitespace differences', () => {
    const { sandbox } = harness()

    const result = sandbox.checkVerbatimCoverage(
      [{ speaker: 'adjuster', text: 'THE   Roof\n is a six twelve with a damaged drip edge' }],
      source,
    )

    expect(result.coverage).toBe(1)
  })

  it('rejects a master containing an invented sentence', () => {
    const { sandbox } = harness()

    const result = sandbox.checkVerbatimCoverage(
      [
        { speaker: 'adjuster', text: 'the roof is a six twelve with a damaged drip edge' },
        {
          speaker: 'adjuster',
          text: 'the homeowner mentioned a prior claim from a hurricane last autumn',
        },
      ],
      source,
    )

    expect(result.coverage).toBeLessThan(0.9)
    expect(result.failing.length).toBeGreaterThan(0)
  })

  it('scores a master shorter than one shingle as a single window', () => {
    const { sandbox } = harness()

    expect(sandbox.checkVerbatimCoverage([{ text: 'the roof is' }], source).coverage).toBe(1)
    expect(sandbox.checkVerbatimCoverage([{ text: 'a burst pipe' }], source).coverage).toBe(0)
  })

  it('scores an empty master as zero rather than dividing by zero', () => {
    const { sandbox } = harness()

    expect(sandbox.checkVerbatimCoverage([], source)).toEqual({
      coverage: 0,
      total: 0,
      passed: 0,
      failing: [],
    })
  })
})

describe('buildGatedMasterTranscript', () => {
  // 17 words, so a one-turn master yields exactly 10 eight-word shingles and
  // each failing one moves coverage by exactly 0.1. Swapping the final word
  // fails only the last window (0.9, the exact accept boundary); swapping the
  // final two fails the last two (0.8, under the gate).
  const SOURCE_TEXT = 'the roof is a six twelve with a damaged drip edge on the front slope and two'

  function gateHarness(turnText: string) {
    return harness({
      callOpenRouter: () => ({
        content: { turns: [{ speaker: 'adjuster', text: turnText }], contested_passages: [] },
        model: 'test-model',
      }),
    })
  }

  function gate(sandbox: Record<string, any>) {
    return sandbox.buildGatedMasterTranscript({
      captureId: 'dograh-1',
      sources: { elevenlabs: { text: SOURCE_TEXT }, dograh: { text: SOURCE_TEXT } },
    })
  }

  it('accepts a fully verbatim master and renders it as speaker-labeled turns', () => {
    const { sandbox, logged } = gateHarness(SOURCE_TEXT)

    const result = gate(sandbox)

    expect(result.accepted).toBe(true)
    expect(result.coverage).toBe(1)
    expect(result.text).toBe('adjuster: ' + SOURCE_TEXT)
    expect(logged.map((l) => l.event)).not.toContain('master_transcript.low_coverage')
  })

  it('accepts but flags a master sitting exactly on the 0.90 boundary', () => {
    // One invented word at the tail fails 1 of 10 shingles.
    const { sandbox, logged } = gateHarness(SOURCE_TEXT.replace(/two$/, 'shingles'))

    const result = gate(sandbox)

    expect(result.coverage).toBe(0.9)
    expect(result.accepted).toBe(true)
    expect(logged.map((l) => l.event)).toContain('master_transcript.low_coverage')
  })

  it('rejects just under 0.90 and names the source that will be substituted', () => {
    const { sandbox, logged } = gateHarness(SOURCE_TEXT.replace(/and two$/, 'plus shingles'))

    const result = gate(sandbox)

    expect(result.coverage).toBe(0.8)
    expect(result.accepted).toBe(false)
    // The rejected master is still rendered, so the caller can keep it in the
    // call folder for inspection.
    expect(result.text).toContain('adjuster: ')

    const violation = logged.find((l) => l.event === 'master_transcript.verbatim_violation')
    expect(violation?.fields.substituted_source).toBe('elevenlabs')
  })

  it('names the retell source when the gate rejects a master built with a retell precedence', () => {
    const { sandbox, logged } = harness({
      callOpenRouter: () => ({
        content: {
          turns: [{ speaker: 'adjuster', text: SOURCE_TEXT.replace(/and two$/, 'plus shingles') }],
          contested_passages: [],
        },
        model: 'test-model',
      }),
    })

    const result = sandbox.buildGatedMasterTranscript({
      captureId: 'retell-1',
      sources: { elevenlabs: { text: SOURCE_TEXT }, retell: { text: SOURCE_TEXT } },
      precedence: ['elevenlabs', 'qwen', 'retell'],
    })

    expect(result.coverage).toBe(0.8)
    expect(result.accepted).toBe(false)

    const violation = logged.find((l) => l.event === 'master_transcript.verbatim_violation')
    expect(violation?.fields.substituted_source).toBe('elevenlabs')
  })

  it('rejects a master whose every phrase was authored rather than selected', () => {
    const { sandbox } = gateHarness(
      'the homeowner told me about a prior claim from a hurricane last autumn and a burst pipe',
    )

    const result = gate(sandbox)

    expect(result.coverage).toBe(0)
    expect(result.accepted).toBe(false)
  })

  it('does not penalise a turn boundary where the merge legitimately switched source', () => {
    const { sandbox } = harness({
      callOpenRouter: () => ({
        content: {
          turns: [
            { speaker: 'adjuster', text: 'the roof is a six twelve with a damaged drip edge' },
            { speaker: 'agent', text: 'hail bruising across the back slope of the roof as well' },
          ],
          contested_passages: [],
        },
        model: 'test-model',
      }),
    })

    const result = sandbox.buildGatedMasterTranscript({
      captureId: 'dograh-1',
      sources: {
        elevenlabs: {
          text: 'the roof is a six twelve with a damaged drip edge on the front slope',
        },
        qwen: { text: 'there is hail bruising across the back slope of the roof as well' },
      },
    })

    expect(result.coverage).toBe(1)
    expect(result.accepted).toBe(true)
  })

  it('returns null when the merge produced no turns at all', () => {
    const { sandbox, logged } = gateHarness('   ')

    expect(gate(sandbox)).toBeNull()
    expect(logged.map((l) => l.event)).toContain('master_transcript.empty')
  })
})

describe('buildSpanHaystack', () => {
  it('strips the speaker labels the merge model added and keeps turns on their own lines', () => {
    const { sandbox } = harness()

    const haystack = sandbox.buildSpanHaystack(
      'adjuster: the roof is a six twelve\nagent: and the elevations?\nadjuster: front had hail',
    )

    expect(haystack).toBe('the roof is a six twelve\nand the elevations?\nfront had hail')
  })

  it('leaves a span straddling two turns unfindable, which is the safe direction', () => {
    const { sandbox } = harness()

    const haystack = sandbox.buildSpanHaystack(
      'adjuster: the roof is a six twelve\nadjuster: front had hail',
    )

    expect(haystack.indexOf('six twelve front had hail')).toBe(-1)
    expect(haystack.indexOf('the roof is a six twelve')).toBeGreaterThan(-1)
  })
})
