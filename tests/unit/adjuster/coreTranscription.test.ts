import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

// The core half of transcription — keyterms, request building, WAV probing and
// slicing, response parsing, source precedence, and the fan-out itself. Split
// out of transcription.test.ts along the same seam the module split on (spec
// 021 phase 3.4).
//
// The sandbox loads core files only and seeds no Apps Script global of any
// kind, so anything core reaches for outside itself is a ReferenceError here
// rather than something a stub quietly satisfies. Everything the fan-out needs
// from its host arrives as `deps`.

function bytesOf(text: string) {
  return Array.from(text, (c) => c.charCodeAt(0))
}

function bodyText(payload: number[]) {
  return payload.map((b) => String.fromCharCode(b)).join('')
}

/** A real PCM WAV byte array, so probeWav/sliceWav are exercised for real. */
function makeWav({ seconds = 1, sampleRate = 8000, channels = 1, bits = 16 } = {}) {
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = Math.round(seconds * byteRate)
  const bytes: number[] = []
  const tag = (t: string) => bytes.push(...bytesOf(t))
  const u16 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff)
  const u32 = (n: number) =>
    bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff)

  tag('RIFF')
  u32(36 + dataSize)
  tag('WAVE')
  tag('fmt ')
  u32(16)
  u16(1)
  u16(channels)
  u32(sampleRate)
  u32(byteRate)
  u16(blockAlign)
  u16(bits)
  tag('data')
  u32(dataSize)
  for (let i = 0; i < dataSize; i++) bytes.push(i % 256)

  return bytes
}

/** What the adapter hands core in place of a Drive Blob. */
function audioOf(bytes: number[], overrides: Record<string, unknown> = {}) {
  return { bytes, name: 'audio.wav', contentType: 'audio/wav', ...overrides }
}

/** deps.fetch's response shape. */
function response(status: number, body: string) {
  return { status, body, headers: {} }
}

const CORE_FILES = ['apps/adjuster/src/core/deps.js', 'apps/adjuster/src/core/transcription.js']

function harness(overrides: { fetchAll?: (requests: any[]) => any[]; fetch?: () => any } = {}) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const fetchAllCalls: any[][] = []

  const fetchOne = vi.fn(overrides.fetch ?? (() => null))
  const fetchAll = vi.fn((requests: any[]) => {
    fetchAllCalls.push(requests)
    if (!overrides.fetchAll) return { responses: [], mode: 'fetch_all' }
    try {
      return { responses: overrides.fetchAll(requests), mode: 'fetch_all' }
    } catch (err) {
      logged.push({ event: 'transcription.fetch_all_failed', fields: { error: String(err) } })
      return { responses: requests.map(() => fetchOne()), mode: 'sequential' }
    }
  })

  const deps = {
    fetch: fetchOne,
    fetchAll,
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      logServerOnly: () => {},
    },
    sleep: () => {},
    base64Encode: (bytes: number[]) => 'b64-' + bytes.length,
    stringToBytes: (text: string) => bytesOf(text),
  }

  const sandbox = loadGs(CORE_FILES)

  return { sandbox, logged, deps, fetchAllCalls, fetchOne }
}

const CONFIG = { elevenLabsApiKey: 'xi-key', openRouterApiKey: 'or-key' }

// A real .wav written by a real encoder, not one makeWav built to the same
// assumptions probeWav makes. Reading it the way the Node harness reads a saved
// recording — off disk, as bytes — is what proves the probe works on a file
// core did not produce itself.
function fixtureWav() {
  return Array.from(readFileSync('tests/fixtures/adjuster/tone-440hz-8khz-mono.wav'))
}

describe('buildKeyterms', () => {
  const claim = {
    insured_last_name: 'Henderson',
    address_line1: '412 Dare Dr',
    city: 'Concord',
    carrier: 'Allstate',
    claim_number: 'CLF-9921',
    vendor: 'IBIS',
  }

  it('orders claim proper nouns, then the adjuster, then the glossary', () => {
    const { sandbox } = harness()

    const terms = sandbox.buildKeyterms(
      claim,
      [{ term: 'drip edge' }, { term: 'pipe boot' }],
      'Brandon',
    )

    expect(terms).toEqual([
      'Henderson',
      '412 Dare Dr',
      'Concord',
      'Allstate',
      'CLF-9921',
      'Brandon',
      'drip edge',
      'pipe boot',
    ])
  })

  it('drops case-insensitive duplicates and never sends a field the claim does not have', () => {
    const { sandbox } = harness()

    const terms = sandbox.buildKeyterms({ city: 'Concord' }, [{ term: 'concord' }], 'Brandon')

    expect(terms).toEqual(['Concord', 'Brandon'])
  })

  it('drops the characters ElevenLabs rejects and caps a term at 5 words', () => {
    const { sandbox } = harness()

    const terms = sandbox.buildKeyterms(
      null,
      [{ term: 'roof [decking] <north>' }, { term: 'one two three four five six seven' }],
      '',
    )

    expect(terms[0]).toBe('roof decking north')
    expect(terms[1]).toBe('one two three four five')
  })

  it('caps at 1000 terms and 49 characters each', () => {
    const { sandbox } = harness()
    const glossary = Array.from({ length: 1200 }, (_, i) => ({ term: 'term-' + i }))

    const terms = sandbox.buildKeyterms({ city: 'x'.repeat(80) }, glossary, 'Brandon')

    expect(terms).toHaveLength(1000)
    expect(terms[0]).toHaveLength(49)
    expect(terms.every((term: string) => term.length <= 50)).toBe(true)
  })
})

describe('selectFallbackTranscript', () => {
  const cases: Array<[string, Record<string, { text: string }>, string]> = [
    [
      'elevenlabs when it has text',
      { elevenlabs: { text: 'eleven' }, qwen: { text: 'qwen' }, dograh: { text: 'dograh' } },
      'elevenlabs',
    ],
    [
      'qwen when elevenlabs is empty',
      { elevenlabs: { text: '' }, qwen: { text: 'qwen' }, dograh: { text: 'dograh' } },
      'qwen',
    ],
    [
      'dograh only when both ASR sources are empty',
      { elevenlabs: { text: '' }, qwen: { text: '   ' }, dograh: { text: 'dograh' } },
      'dograh',
    ],
  ]

  it.each(cases)('returns %s', (_label, sources, expected) => {
    const { sandbox } = harness()
    expect(sandbox.selectFallbackTranscript(sources).source).toBe(expected)
  })

  it('returns no source when nothing produced text', () => {
    const { sandbox } = harness()
    expect(sandbox.selectFallbackTranscript({}).source).toBe('')
  })

  it('is the same ordering the merge prompt is given', () => {
    const { sandbox } = harness()
    expect(sandbox.SOURCE_PRECEDENCE).toEqual(['elevenlabs', 'qwen', 'dograh'])
  })

  it('honors an explicit precedence with a retell source in the third slot', () => {
    const { sandbox } = harness()
    const retellSources = { elevenlabs: { text: '' }, qwen: { text: '' }, retell: { text: 'r' } }
    const precedence = ['elevenlabs', 'qwen', 'retell']

    expect(sandbox.selectFallbackTranscript(retellSources, precedence).source).toBe('retell')
    expect(sandbox.availableSources(retellSources, precedence)).toEqual(['retell'])
  })
})

describe('coreTranscribe', () => {
  function asrHarness(fetchAll: (requests: any[]) => any[], fetch = () => null) {
    return harness({ fetchAll, fetch })
  }

  const elevenBody = JSON.stringify({
    text: 'the roof is a six twelve',
    words: [
      { text: 'the', speaker_id: 'speaker_0' },
      { text: ' ', speaker_id: 'speaker_0' },
      { text: 'roof', speaker_id: 'speaker_0' },
      { text: 'okay', speaker_id: 'speaker_1' },
    ],
    audio_duration_secs: 610,
  })
  const qwenBody = JSON.stringify({
    text: 'the roof is a 6/12',
    usage: { seconds: 610, cost: 0.02 },
  })

  function run(sandbox: Record<string, any>, deps: Record<string, unknown>) {
    return sandbox.coreTranscribe({
      captureId: 'dograh-1',
      audio: audioOf(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: ['Henderson'],
      config: CONFIG,
      deps,
    })
  }

  it('issues both ASR calls in a single fetchAll with two request objects', () => {
    const { sandbox, deps, fetchAllCalls } = asrHarness(() => [
      response(200, elevenBody),
      response(200, qwenBody),
    ])

    const result = run(sandbox, deps)

    expect(deps.fetchAll).toHaveBeenCalledTimes(1)
    const requests = fetchAllCalls[0]
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toContain('api.elevenlabs.io')
    expect(requests[0].headers['xi-api-key']).toBe('xi-key')
    const form = bodyText(requests[0].payload)
    expect(requests[0].contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(form).toContain('name="model_id"\r\n\r\nscribe_v2')
    expect(form).toContain('name="diarize"\r\n\r\ntrue')
    expect(form).toContain('name="file"; filename="audio.wav"')
    expect(requests[1].url).toContain('openrouter.ai/api/v1/audio/transcriptions')
    expect(JSON.parse(requests[1].payload).provider.order).toEqual(['alibaba'])
    expect(result.fetch_mode).toBe('fetch_all')
    expect(result.sources.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.sources.qwen.text).toBe('the roof is a 6/12')
  })

  it('turns the diarized words array into speaker turns', () => {
    const { sandbox, deps } = asrHarness(() => [response(200, elevenBody), response(200, qwenBody)])

    const result = run(sandbox, deps)

    expect(result.sources.elevenlabs.turns).toEqual([
      { speaker: 'speaker_0', text: 'the roof' },
      { speaker: 'speaker_1', text: 'okay' },
    ])
  })

  it.each([
    ['elevenlabs', 0],
    ['qwen', 1],
  ])('leaves %s empty when its call fails without touching the other', (dead, index) => {
    const responses = [response(200, elevenBody), response(200, qwenBody)]
    responses[index] = response(400, 'nope')
    const { sandbox, deps } = asrHarness(() => responses)

    const result = run(sandbox, deps)
    const alive = dead === 'elevenlabs' ? 'qwen' : 'elevenlabs'

    expect(result.sources[dead].text).toBe('')
    expect(result.sources[dead].ok).toBe(false)
    expect(result.sources[alive].text).not.toBe('')
  })

  it.each([
    ['elevenlabs', 0],
    ['qwen', 1],
  ])("logs %s's error body so a 400 is debuggable after the fact", (dead, index) => {
    const detail = JSON.stringify({ detail: [{ loc: ['body', 'file'], msg: 'audio too short' }] })
    const responses = [response(200, elevenBody), response(200, qwenBody)]
    responses[index] = response(400, detail)
    const { sandbox, logged, deps } = asrHarness(() => responses)

    run(sandbox, deps)

    const finished = logged.filter((l) => l.event === 'transcription.source_finished')
    const failed = finished.find((l) => l.fields.source === dead)
    expect(failed?.fields.status).toBe(400)
    expect(failed?.fields.error).toBe(detail)

    // The source that succeeded carries no error, so the field stays scannable.
    const alive = dead === 'elevenlabs' ? 'qwen' : 'elevenlabs'
    expect(finished.find((l) => l.fields.source === alive)?.fields.error).toBe('')
  })

  it('caps a runaway error body rather than logging it whole', () => {
    const { sandbox, logged, deps } = asrHarness(() => [
      response(200, elevenBody),
      response(400, 'x'.repeat(5000)),
    ])

    run(sandbox, deps)

    const qwen = logged
      .filter((l) => l.event === 'transcription.source_finished')
      .find((l) => l.fields.source === 'qwen')
    expect(String(qwen?.fields.error)).toHaveLength(2000)
  })

  it('sends one keyterms form field per term, never a JSON array in one field', () => {
    const { sandbox, deps, fetchAllCalls } = asrHarness(() => [
      response(200, elevenBody),
      response(200, qwenBody),
    ])

    sandbox.coreTranscribe({
      captureId: 'dograh-1',
      audio: audioOf(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: ['Henderson', 'drip edge'],
      config: CONFIG,
      deps,
    })

    const requests = fetchAllCalls[0]
    const form = bodyText(requests[0].payload)

    expect(form).toContain('name="keyterms"\r\n\r\nHenderson')
    expect(form).toContain('name="keyterms"\r\n\r\ndrip edge')
    // The single-field JSON array is what ElevenLabs rejected as one 25-char
    // "keyword" over its 50-char per-term limit.
    expect(form).not.toContain('["Henderson"')
  })

  it('splits long audio into one Qwen request per slice and rejoins the text', () => {
    const bodies = ['first part', 'second part', 'third part'].map((text) =>
      response(200, JSON.stringify({ text })),
    )
    const { sandbox, logged, deps, fetchAllCalls } = asrHarness(() => [
      response(200, elevenBody),
      ...bodies,
    ])

    const result = sandbox.coreTranscribe({
      captureId: 'dograh-1',
      audio: audioOf(makeWav({ seconds: 700, sampleRate: 100 })),
      format: 'wav',
      keyterms: [],
      config: CONFIG,
      deps,
    })

    const requests = fetchAllCalls[0]
    expect(requests).toHaveLength(4) // 1 ElevenLabs + 3 Qwen slices
    expect(result.sources.qwen.text).toBe('first part second part third part')
    expect(result.sources.qwen.ok).toBe(true)

    const split = logged.find((l) => l.event === 'transcription.audio_split')
    expect(split?.fields.chunks).toBe(3)
    expect(split?.fields.chunk_seconds).toBe(300)
  })

  it('fails the whole source when one slice fails, rather than leaving a hole', () => {
    const { sandbox, logged, deps } = asrHarness(() => [
      response(200, elevenBody),
      response(200, JSON.stringify({ text: 'first part' })),
      response(400, 'slice two exploded'),
      response(200, JSON.stringify({ text: 'third part' })),
    ])

    const result = sandbox.coreTranscribe({
      captureId: 'dograh-1',
      audio: audioOf(makeWav({ seconds: 700, sampleRate: 100 })),
      format: 'wav',
      keyterms: [],
      config: CONFIG,
      deps,
    })

    expect(result.sources.qwen.ok).toBe(false)
    expect(result.sources.qwen.text).toBe('')
    const finished = logged
      .filter((l) => l.event === 'transcription.source_finished')
      .find((l) => l.fields.source === 'qwen')
    expect(finished?.fields.chunks).toBe(3)
    expect(finished?.fields.error).toBe('slice two exploded')
  })

  it('retries a single source once on a 429 rather than failing it outright', () => {
    const { sandbox, deps, fetchOne } = asrHarness(
      () => [response(429, 'slow down'), response(200, qwenBody)],
      () => response(200, elevenBody) as never,
    )

    const result = run(sandbox, deps)

    expect(fetchOne).toHaveBeenCalledTimes(1)
    expect(result.sources.elevenlabs.text).toBe('the roof is a six twelve')
  })

  it('falls back to sequential fetches when fetchAll itself throws', () => {
    const bodies = [elevenBody, qwenBody]
    let call = 0
    const { sandbox, logged, deps } = asrHarness(
      () => {
        throw new Error('transport blew up')
      },
      (() => response(200, bodies[call++])) as never,
    )

    const result = run(sandbox, deps)

    expect(result.fetch_mode).toBe('sequential')
    expect(result.sources.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.sources.qwen.text).toBe('the roof is a 6/12')
    expect(logged.map((l) => l.event)).toContain('transcription.fetch_all_failed')
  })

  it('skips Qwen and says so when audio is over the cap and cannot be split', () => {
    // Not a WAV, so there is no way to cut it down to Alibaba's 10 MB.
    const opaque = new Array(11 * 1024 * 1024).fill(7)
    const { sandbox, logged, deps, fetchAllCalls } = harness({
      fetchAll: () => [response(200, elevenBody)],
    })

    const result = sandbox.coreTranscribe({
      captureId: 'dograh-1',
      audio: audioOf(opaque, { name: 'audio.mp3', contentType: 'audio/mpeg' }),
      format: 'mp3',
      keyterms: [],
      config: CONFIG,
      deps,
    })

    const requests = fetchAllCalls[0]
    expect(requests).toHaveLength(1)
    expect(result.sources.qwen).toBeUndefined()
    const skipped = logged.find((l) => l.event === 'transcription.audio_too_large')
    expect(skipped?.fields.splittable).toBe(false)
  })
})

describe('probeWav / sliceWav', () => {
  it('reads the format off a real header', () => {
    const { sandbox } = harness()

    const probe = sandbox.probeWav(makeWav({ seconds: 3, sampleRate: 8000 }))

    expect(probe.sampleRate).toBe(8000)
    expect(probe.channels).toBe(1)
    expect(probe.byteRate).toBe(16000)
    expect(probe.seconds).toBeCloseTo(3, 5)
  })

  it('refuses anything that is not uncompressed PCM WAV', () => {
    const { sandbox } = harness()
    const compressed = makeWav({ seconds: 1 })
    compressed[20] = 2 // fmt.format: not PCM

    expect(sandbox.probeWav(compressed)).toBeNull()
    expect(sandbox.probeWav(bytesOf('ID3 this is an mp3'))).toBeNull()
    expect(sandbox.probeWav([])).toBeNull()
  })

  it('cuts a slice that is itself a valid WAV of the right length', () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 10, sampleRate: 8000 })
    const probe = sandbox.probeWav(wav)

    const slice = sandbox.sliceWav(wav, probe, 2, 5)
    const reprobed = sandbox.probeWav(slice)

    expect(reprobed.seconds).toBeCloseTo(3, 5)
    expect(reprobed.sampleRate).toBe(probe.sampleRate)
    expect(reprobed.channels).toBe(probe.channels)
  })

  it('clamps a slice that runs past the end of the data', () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 10 })
    const probe = sandbox.probeWav(wav)

    expect(sandbox.probeWav(sandbox.sliceWav(wav, probe, 8, 999)).seconds).toBeCloseTo(2, 5)
  })

  it('splits losslessly — every PCM byte lands in exactly one slice', () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 9, sampleRate: 100 })
    const probe = sandbox.probeWav(wav)

    const slices = [
      sandbox.sliceWav(wav, probe, 0, 3),
      sandbox.sliceWav(wav, probe, 3, 6),
      sandbox.sliceWav(wav, probe, 6, 9),
    ]
    const pcm = slices.reduce((total, slice) => total + (slice.length - 44), 0)

    expect(pcm).toBe(probe.dataSize)
  })
})

describe('splitForQwen', () => {
  it('sends short audio whole', () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 60, sampleRate: 100 })

    expect(sandbox.splitForQwen(wav, sandbox.probeWav(wav))).toHaveLength(1)
  })

  it("cuts past Alibaba's 300-second cap", () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 700, sampleRate: 100 })

    // 700s at 300s per slice: 300 + 300 + 100.
    expect(sandbox.splitForQwen(wav, sandbox.probeWav(wav))).toHaveLength(3)
  })

  it('gives up on unsplittable audio that is over the byte cap', () => {
    const { sandbox } = harness()

    expect(sandbox.splitForQwen(new Array(11 * 1024 * 1024).fill(7), null)).toEqual([])
  })
})

describe('probeWav against a real file on disk', () => {
  it('reads the format off a wav no test helper generated', () => {
    const { sandbox } = harness()

    const probe = sandbox.probeWav(fixtureWav())

    expect(probe.channels).toBe(1)
    expect(probe.sampleRate).toBe(8000)
    expect(probe.bitsPerSample).toBe(16)
    expect(probe.byteRate).toBe(16000)
    expect(probe.seconds).toBeCloseTo(0.25, 5)
  })

  it('round-trips a slice of it back through the probe', () => {
    const { sandbox } = harness()
    const bytes = fixtureWav()
    const probe = sandbox.probeWav(bytes)

    const slice = sandbox.sliceWav(bytes, probe, 0, 0.1)
    const reprobed = sandbox.probeWav(slice)

    expect(reprobed.sampleRate).toBe(probe.sampleRate)
    expect(reprobed.channels).toBe(probe.channels)
    expect(reprobed.seconds).toBeCloseTo(0.1, 5)
  })

  it("sends it whole, being far under both of Alibaba's caps", () => {
    const { sandbox } = harness()
    const bytes = fixtureWav()

    expect(sandbox.splitForQwen(bytes, sandbox.probeWav(bytes))).toHaveLength(1)
  })
})
