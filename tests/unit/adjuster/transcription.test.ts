import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

type Folder = ReturnType<typeof fakeFolder>

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

function wavBlob(bytes: number[]) {
  return {
    getBytes: () => bytes,
    getName: () => 'audio.wav',
    getContentType: () => 'audio/wav',
  }
}

function fakeFile(name: string, content: string, id = 'file-' + name) {
  const file = {
    id,
    name,
    content,
    getId: () => id,
    getName: () => name,
    setContent: (value: string) => {
      file.content = value
    },
    getBlob: () => ({ getDataAsString: () => file.content }),
  }

  return file
}

function fakeFolder(name: string, id = 'folder-1') {
  const files: ReturnType<typeof fakeFile>[] = []
  const folders: Folder[] = []

  const folder = {
    id,
    name,
    files,
    folders,
    getId: () => id,
    getName: () => folder.name,
    setName: (value: string) => {
      folder.name = value
    },
    createFile: (fileName: string, content: string) => {
      const file = fakeFile(fileName, content, 'file-' + files.length)
      files.push(file)
      return file
    },
    createFolder: (childName: string) => {
      const child = fakeFolder(childName, 'folder-' + (folders.length + 2))
      folders.push(child)
      return child
    },
    getFilesByName: (fileName: string) => iterator(files.filter((f) => f.name === fileName)),
    getFoldersByName: (folderName: string) =>
      iterator(folders.filter((f) => f.getName() === folderName)),
  }

  return folder
}

function iterator<T>(items: T[]) {
  let index = 0
  return {
    hasNext: () => index < items.length,
    next: () => items[index++],
  }
}

/**
 * A Drive File stand-in that tracks sharing state, since ElevenLabs now fetches
 * the recording from a URL rather than receiving an upload — see
 * withPubliclySharedFile. Starts PRIVATE, like a real Drive file in a
 * restricted folder.
 */
function fakeAudioFile(id = 'audio-1') {
  let access = 'PRIVATE'
  let permission = 'NONE'

  return {
    getId: () => id,
    getName: () => 'audio.wav',
    getBlob: () => wavBlob(makeWav({ seconds: 1 })),
    getSharingAccess: () => access,
    getSharingPermission: () => permission,
    setSharing: (nextAccess: string, nextPermission: string) => {
      access = nextAccess
      permission = nextPermission
    },
  }
}

function response(status: number, body: string) {
  return { getResponseCode: () => status, getContentText: () => body }
}

const SOURCES = ['apps/adjuster/src/util.js', 'apps/adjuster/src/transcription.js']

function harness(overrides: Record<string, unknown> = {}) {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const properties: Record<string, string> = (overrides.properties as Record<string, string>) ?? {
    CALL_ARTIFACTS_FOLDER_ID: 'root-1',
    MASTER_TRANSCRIPT_MODE: 'shadow',
  }
  delete overrides.properties

  const root = fakeFolder('root', 'root-1')
  const filesById: Record<string, ReturnType<typeof fakeFile>> = {}
  const foldersById: Record<string, Folder> = { 'root-1': root }

  // Access/Permission are real enums withPubliclySharedFile reads off DriveApp
  // itself, so every test gets them for free; a per-test DriveApp override only
  // needs to supply the methods it actually cares about (getFileById, etc.).
  const driveApp = {
    Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { NONE: 'NONE', VIEW: 'VIEW' },
    getFolderById: (id: string) => {
      if (!foldersById[id]) throw new Error('No folder ' + id)
      return foldersById[id]
    },
    getFileById: (id: string) => {
      if (!filesById[id]) throw new Error('No file ' + id)
      return filesById[id]
    },
    ...(overrides.DriveApp as Record<string, unknown> | undefined),
  }
  delete overrides.DriveApp

  const sandbox = loadGs(SOURCES, {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    describeError: (err: Error) => ({ error: String(err.message ?? err), stack: '' }),
    getConfig: (key: string) => {
      if (properties[key] === undefined) throw new Error('Missing script property: ' + key)
      return properties[key]
    },
    getOptionalConfig: (key: string, fallback: string) =>
      properties[key] === undefined ? fallback : properties[key],
    getConfigList: () => [],
    DriveApp: driveApp,
    Utilities: {
      base64Encode: (bytes: number[]) => 'b64-' + bytes.length,
      newBlob: (text: string) => ({ getBytes: () => bytesOf(text) }),
      sleep: () => {},
    },
    UrlFetchApp: { fetchAll: () => [], fetch: () => null },
    withJobLock: (fn: () => unknown) => fn(),
    ...overrides,
  })

  return { sandbox, logged, root, filesById, foldersById, properties }
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

// docs/specs/022 — the projection matching reads instead of the raw
// transcript. Recognizes each label vocabulary that appears somewhere in the
// pipeline (see the header comment above TRANSCRIPT_LABEL_VOCABULARIES) and
// keeps only the adjuster's own lines.
describe('adjusterTurnsOf', () => {
  it('drops the agent turns from a Retell raw transcript', () => {
    const { sandbox } = harness()

    const result = sandbox.adjusterTurnsOf(
      'Agent: Are you calling about Maple Street for RAY?\nUser: No.\nUser: 1003 Venus Street.',
    )

    expect(result).toBe('No.\n1003 Venus Street.')
  })

  it('drops the agent turns from a master transcript', () => {
    const { sandbox } = harness()

    const result = sandbox.adjusterTurnsOf(
      'agent: Are you calling about Maple Street for RAY?\nadjuster: No.\nadjuster: 1003 Venus Street.',
    )

    expect(result).toBe('No.\n1003 Venus Street.')
  })

  it('drops the agent turns from a Dograh Notetaker export', () => {
    const { sandbox } = harness()

    const result = sandbox.adjusterTurnsOf('Q: What is the address?\nA: 1003 Venus Street.')

    expect(result).toBe('1003 Venus Street.')
  })

  it('passes an unlabeled monologue through unchanged', () => {
    const { sandbox } = harness()

    const result = sandbox.adjusterTurnsOf('Roof is a 3-tab asphalt shingle, twelve years old.')

    expect(result).toBe('Roof is a 3-tab asphalt shingle, twelve years old.')
  })

  it('passes the input through unchanged rather than returning empty when every line is an agent turn', () => {
    const { sandbox } = harness()
    const allAgent = 'Agent: Hello.\nAgent: Are you still there?'

    const result = sandbox.adjusterTurnsOf(allAgent)

    expect(result).toBe(allAgent)
  })

  it('passes an empty transcript through unchanged', () => {
    const { sandbox } = harness()

    expect(sandbox.adjusterTurnsOf('')).toBe('')
  })
})

describe('detectLabelVocabulary', () => {
  it('names each recognized vocabulary', () => {
    const { sandbox } = harness()

    expect(sandbox.detectLabelVocabulary('Agent: hi\nUser: hi')).toBe('retell')
    expect(sandbox.detectLabelVocabulary('agent: hi\nadjuster: hi')).toBe('master')
    expect(sandbox.detectLabelVocabulary('Q: hi\nA: hi')).toBe('dograh-notetaker')
  })

  it('returns empty string for a transcript with no recognized labels', () => {
    const { sandbox } = harness()

    expect(sandbox.detectLabelVocabulary('Roof is a 3-tab asphalt shingle.')).toBe('')
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

describe('transcribeInParallel', () => {
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

  /**
   * ElevenLabs is phase A and goes out on its own UrlFetchApp.fetch; the Qwen
   * slices are phase B and go out together through fetchAll. `fetch` is routed
   * by URL so a Qwen retry can never eat an ElevenLabs response, and vice versa.
   */
  function asrHarness({
    qwen = [response(200, qwenBody)],
    eleven = [response(200, elevenBody)],
    qwenDirect = [],
  }: {
    qwen?: unknown[] | (() => unknown[])
    eleven?: unknown[]
    qwenDirect?: unknown[]
  } = {}) {
    const elevenQueue = [...eleven]
    const qwenQueue = [...qwenDirect]

    return harness({
      UrlFetchApp: {
        fetchAll: vi.fn(typeof qwen === 'function' ? qwen : () => qwen),
        fetch: vi.fn((url: string) =>
          String(url).includes('elevenlabs') ? elevenQueue.shift() : qwenQueue.shift(),
        ),
      },
    })
  }

  function batchedRequests(sandbox: Record<string, any>) {
    const mock = sandbox.UrlFetchApp.fetchAll as ReturnType<typeof vi.fn>
    return mock.mock.calls.length ? mock.mock.calls[0][0] : []
  }

  function elevenRequest(sandbox: Record<string, any>) {
    return (sandbox.UrlFetchApp.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
  }

  // /v1/speech-to-text is multipart/form-data only, so the payload is a wire
  // body rather than JSON. Parsed back into { name -> value | value[] } so the
  // assertions below can stay about content instead of boundary syntax;
  // keyterms is a repeated field, which is why repeats collect into an array.
  function elevenPayload(sandbox: Record<string, any>): Record<string, any> {
    const raw: string = elevenRequest(sandbox).payload
    const fields: Record<string, any> = {}

    raw.split(/\r\n/).forEach((line, i, lines) => {
      const match = /^Content-Disposition: form-data; name="([^"]+)"$/.exec(line)
      if (!match) return

      const name = match[1]
      const value = lines[i + 2]

      if (fields[name] === undefined) fields[name] = value
      else if (Array.isArray(fields[name])) fields[name].push(value)
      else fields[name] = [fields[name], value]
    })

    return fields
  }

  function run(sandbox: Record<string, any>) {
    return sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: wavBlob(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: ['Henderson'],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })
  }

  it('sends ElevenLabs a multipart form naming a source_url, and batches the Qwen slices through fetchAll', () => {
    const { sandbox } = asrHarness()

    const result = run(sandbox)

    expect(sandbox.UrlFetchApp.fetch).toHaveBeenCalledTimes(1)
    const eleven = elevenRequest(sandbox)
    expect(eleven.url).toContain('api.elevenlabs.io')
    expect(eleven.headers['xi-api-key']).toBe('xi-key')
    // Not application/json. A JSON body parses to no form fields at all and
    // the endpoint answers 422 "model_id Field required" with "input": null —
    // the failure that silently cost every run its ElevenLabs source between
    // 2026-09-13 and this fix.
    expect(eleven.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const body = elevenPayload(sandbox)
    expect(body.model_id).toBe('scribe_v2')
    expect(body.diarize).toBe('true')
    expect(body.source_url).toContain('drive.google.com')
    expect(body.source_url).toContain('audio-1')
    // Still no file part — that is what source_url bought, and putting one
    // back would restore the OOM.
    expect(body.file).toBeUndefined()
    expect(eleven.payload).not.toContain('filename=')

    const batched = batchedRequests(sandbox)
    expect(batched).toHaveLength(1)
    expect(batched[0].url).toContain('openrouter.ai/api/v1/audio/transcriptions')
    expect(JSON.parse(batched[0].payload).provider.order).toEqual(['alibaba'])

    expect(result.fetch_mode).toBe('elevenlabs+qwen:fetch_all')
    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.qwen.text).toBe('the roof is a 6/12')
  })

  it('never reads the recording into a byte array for ElevenLabs, only for Qwen', () => {
    // The whole point of source_url: ElevenLabs fetches the recording itself,
    // so this script never calls getBytes() on its behalf. Qwen still does,
    // once, to plan and cut its slices.
    const order: string[] = []
    const wav = makeWav({ seconds: 1 })
    const { sandbox } = harness({
      UrlFetchApp: {
        fetchAll: vi.fn(() => {
          order.push('fetchAll')
          return [response(200, qwenBody)]
        }),
        fetch: vi.fn(() => {
          order.push('fetch:elevenlabs')
          return response(200, elevenBody)
        }),
      },
    })

    sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: {
        getBytes: () => {
          order.push('getBytes')
          return wav
        },
        getName: () => 'audio.wav',
        getContentType: () => 'audio/wav',
      },
      format: 'wav',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    expect(order).toEqual(['fetch:elevenlabs', 'getBytes', 'fetchAll'])
  })

  it('shares the recording only for the span of the ElevenLabs request, then reverts it', () => {
    const audioFile = fakeAudioFile()
    let accessDuringFetch = ''

    const { sandbox } = harness({
      UrlFetchApp: {
        fetchAll: () => [response(200, qwenBody)],
        fetch: (url: string) => {
          if (String(url).includes('elevenlabs')) accessDuringFetch = audioFile.getSharingAccess()
          return response(200, elevenBody)
        },
      },
    })

    expect(audioFile.getSharingAccess()).toBe('PRIVATE')

    sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile,
      audioBlob: wavBlob(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    expect(accessDuringFetch).toBe('ANYONE_WITH_LINK')
    expect(audioFile.getSharingAccess()).toBe('PRIVATE')
  })

  it('reverts sharing even when something throws after it was granted', () => {
    // safeFetch swallows network errors, so the only realistic way anything
    // inside the shared span throws is a Drive call itself failing — this
    // simulates that rather than a fetch throw, to exercise the finally.
    const audioFile = fakeAudioFile()
    audioFile.getId = () => {
      throw new Error('drive blew up')
    }

    const { sandbox, logged } = harness({
      UrlFetchApp: {
        fetchAll: () => [response(200, qwenBody)],
        fetch: () => response(200, elevenBody),
      },
    })

    const result = sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile,
      audioBlob: wavBlob(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    expect(audioFile.getSharingAccess()).toBe('PRIVATE')
    expect(result.elevenlabs.ok).toBe(false)
    expect(logged.map((l) => l.event)).toContain('transcription.elevenlabs_share_failed')
  })

  it('turns the diarized words array into speaker turns', () => {
    const { sandbox } = asrHarness()

    const result = run(sandbox)

    expect(result.elevenlabs.turns).toEqual([
      { speaker: 'speaker_0', text: 'the roof' },
      { speaker: 'speaker_1', text: 'okay' },
    ])
  })

  it.each([
    ['elevenlabs', { eleven: [response(400, 'nope')] }],
    ['qwen', { qwen: [response(400, 'nope')] }],
  ])('leaves %s empty when its call fails without touching the other', (dead, broken) => {
    const { sandbox } = asrHarness(broken)

    const result = run(sandbox)
    const alive = dead === 'elevenlabs' ? 'qwen' : 'elevenlabs'

    expect(result[dead].text).toBe('')
    expect(result[dead].ok).toBe(false)
    expect(result[alive].text).not.toBe('')
  })

  it.each([
    ['elevenlabs', 'eleven'],
    ['qwen', 'qwen'],
  ])("logs %s's error body so a 400 is debuggable after the fact", (dead, key) => {
    const detail = JSON.stringify({ detail: [{ loc: ['body', 'file'], msg: 'audio too short' }] })
    const { sandbox, logged } = asrHarness({ [key]: [response(400, detail)] })

    run(sandbox)

    const finished = logged.filter((l) => l.event === 'transcription.source_finished')
    const failed = finished.find((l) => l.fields.source === dead)
    expect(failed?.fields.status).toBe(400)
    expect(failed?.fields.error).toBe(detail)

    // The source that succeeded carries no error, so the field stays scannable.
    const alive = dead === 'elevenlabs' ? 'qwen' : 'elevenlabs'
    expect(finished.find((l) => l.fields.source === alive)?.fields.error).toBe('')
  })

  it('caps a runaway error body rather than logging it whole', () => {
    const { sandbox, logged } = asrHarness({ qwen: [response(400, 'x'.repeat(5000))] })

    run(sandbox)

    const qwen = logged
      .filter((l) => l.event === 'transcription.source_finished')
      .find((l) => l.fields.source === 'qwen')
    expect(String(qwen?.fields.error)).toHaveLength(2000)
  })

  it('sends keyterms as a real JSON array', () => {
    const { sandbox } = asrHarness()

    sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: wavBlob(makeWav({ seconds: 1 })),
      format: 'wav',
      keyterms: ['Henderson', 'drip edge'],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    expect(elevenPayload(sandbox).keyterms).toEqual(['Henderson', 'drip edge'])
  })

  it('splits long audio into one Qwen request per slice and rejoins the text', () => {
    const { sandbox, logged } = asrHarness({
      qwen: ['first part', 'second part', 'third part'].map((text) =>
        response(200, JSON.stringify({ text })),
      ),
    })

    const result = sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: wavBlob(makeWav({ seconds: 700, sampleRate: 100 })),
      format: 'wav',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    // Only the slices are batched — the ElevenLabs body is never in here.
    const batched = batchedRequests(sandbox)
    expect(batched).toHaveLength(3)
    // base64Encode is stubbed to 'b64-<length>', so each payload names the size
    // of the slice it was cut from: 300s, 300s and the 100s remainder, each
    // carrying its own 44-byte header. Proof the spans were cut one at a time.
    expect(batched.map((r: { payload: string }) => JSON.parse(r.payload).input_audio.data)).toEqual(
      ['b64-60044', 'b64-60044', 'b64-20044'],
    )
    expect(result.qwen.text).toBe('first part second part third part')
    expect(result.qwen.ok).toBe(true)

    const split = logged.find((l) => l.event === 'transcription.audio_split')
    expect(split?.fields.chunks).toBe(3)
    expect(split?.fields.chunk_seconds).toBe(300)
  })

  it('fails the whole source when one slice fails, rather than leaving a hole', () => {
    const { sandbox, logged } = asrHarness({
      qwen: [
        response(200, JSON.stringify({ text: 'first part' })),
        response(400, 'slice two exploded'),
        response(200, JSON.stringify({ text: 'third part' })),
      ],
    })

    const result = sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: wavBlob(makeWav({ seconds: 700, sampleRate: 100 })),
      format: 'wav',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    expect(result.qwen.ok).toBe(false)
    expect(result.qwen.text).toBe('')
    const finished = logged
      .filter((l) => l.event === 'transcription.source_finished')
      .find((l) => l.fields.source === 'qwen')
    expect(finished?.fields.chunks).toBe(3)
    expect(finished?.fields.error).toBe('slice two exploded')
  })

  it('retries a Qwen slice once on a 429 rather than failing the source', () => {
    const { sandbox } = asrHarness({
      qwen: [response(429, 'slow down')],
      qwenDirect: [response(200, qwenBody)],
    })

    const result = run(sandbox)

    expect(result.qwen.text).toBe('the roof is a 6/12')
    expect(sandbox.UrlFetchApp.fetch).toHaveBeenCalledTimes(2) // ElevenLabs, then the retry
  })

  it('retries ElevenLabs once on a 429 rather than failing it outright', () => {
    const { sandbox } = asrHarness({
      eleven: [response(429, 'slow down'), response(200, elevenBody)],
    })

    const result = run(sandbox)

    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
    expect(sandbox.UrlFetchApp.fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to sequential fetches when fetchAll itself throws', () => {
    const { sandbox, logged } = asrHarness({
      qwen: () => {
        throw new Error('transport blew up')
      },
      qwenDirect: [response(200, qwenBody)],
    })

    const result = run(sandbox)

    expect(result.fetch_mode).toBe('elevenlabs+qwen:sequential')
    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.qwen.text).toBe('the roof is a 6/12')
    expect(logged.map((l) => l.event)).toContain('transcription.fetch_all_failed')
  })

  it('skips Qwen and says so when audio is over the cap and cannot be split', () => {
    // Not a WAV, so there is no way to cut it down to Alibaba's 10 MB.
    const opaque = new Array(11 * 1024 * 1024).fill(7)
    const { sandbox, logged } = asrHarness()

    const result = sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioFile: fakeAudioFile(),
      audioBlob: { ...wavBlob(opaque), getName: () => 'audio.mp3' },
      format: 'mp3',
      keyterms: [],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })

    // Nothing to batch, so fetchAll is never reached at all.
    expect(sandbox.UrlFetchApp.fetchAll).not.toHaveBeenCalled()
    expect(sandbox.UrlFetchApp.fetch).toHaveBeenCalledTimes(1)
    expect(result.qwen).toBeUndefined()
    expect(result.fetch_mode).toBe('elevenlabs')
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

describe('planQwenSpans', () => {
  it('sends short audio whole, as one uncut span', () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 60, sampleRate: 100 })

    expect(sandbox.planQwenSpans(wav, sandbox.probeWav(wav))).toEqual([null])
  })

  it("cuts past Alibaba's 300-second cap", () => {
    const { sandbox } = harness()
    const wav = makeWav({ seconds: 700, sampleRate: 100 })

    // 700s at 300s per slice: 300 + 300 + 100. Spans, not slices — the bytes are
    // cut one at a time by the caller so two full copies never coexist.
    expect(sandbox.planQwenSpans(wav, sandbox.probeWav(wav))).toEqual([
      [0, 300],
      [300, 600],
      [600, 700],
    ])
  })

  it('gives up on unsplittable audio that is over the byte cap', () => {
    const { sandbox } = harness()

    expect(sandbox.planQwenSpans(new Array(11 * 1024 * 1024).fill(7), null)).toEqual([])
  })
})

describe('getOrCreateCallFolder', () => {
  it('names the folder by date, insured last name, and capture id', () => {
    const { sandbox, root } = harness()

    const folder = sandbox.getOrCreateCallFolder(
      { capture_id: 'dograh-14829', call_started_at: '2026-08-26T18:04:00Z' },
      { insured_last_name: 'Henderson' },
    )

    expect(folder.getName()).toBe('2026-08-26 Henderson dograh-14829')
    expect(root.folders).toHaveLength(1)
  })

  it('says unmatched when no claim is known yet', () => {
    const { sandbox } = harness()

    const folder = sandbox.getOrCreateCallFolder(
      { capture_id: 'dograh-1', call_started_at: '2026-08-26T18:04:00Z' },
      null,
    )

    expect(folder.getName()).toBe('2026-08-26 unmatched dograh-1')
  })

  it('reuses the folder on a retry instead of creating a second one', () => {
    const { sandbox, root, foldersById } = harness()
    const job = { capture_id: 'dograh-1', call_started_at: '2026-08-26T18:04:00Z' }

    const first = sandbox.getOrCreateCallFolder(job, null)
    foldersById[first.getId()] = first

    const second = sandbox.getOrCreateCallFolder({ ...job, call_folder_id: first.getId() }, null)

    expect(second.getId()).toBe(first.getId())
    expect(root.folders).toHaveLength(1)
  })

  it('renames the webhook-era unmatched folder once the claim is known', () => {
    const { sandbox, foldersById } = harness()
    const job = { capture_id: 'dograh-1', call_started_at: '2026-08-26T18:04:00Z' }

    const first = sandbox.getOrCreateCallFolder(job, null)
    foldersById[first.getId()] = first

    const renamed = sandbox.getOrCreateCallFolder(
      { ...job, call_folder_id: first.getId() },
      { insured_last_name: 'Henderson' },
    )

    expect(renamed.getId()).toBe(first.getId())
    expect(renamed.getName()).toBe('2026-08-26 Henderson dograh-1')
  })

  it('returns null rather than throwing when CALL_ARTIFACTS_FOLDER_ID is unset', () => {
    const { sandbox } = harness({ properties: { MASTER_TRANSCRIPT_MODE: 'shadow' } })

    expect(sandbox.getOrCreateCallFolder({ capture_id: 'dograh-1' }, null)).toBeNull()
  })
})

describe('writeCallArtifact', () => {
  it('versions the filename rather than overwriting a previous run', () => {
    const { sandbox } = harness()
    const folder = fakeFolder('call')

    sandbox.writeCallArtifact(folder, 'transcript-master.txt', 'first run')
    sandbox.writeCallArtifact(folder, 'transcript-master.txt', 'second run')

    expect(folder.files.map((f) => f.name)).toEqual([
      'transcript-master.txt',
      'transcript-master-2.txt',
    ])
    expect(folder.files[0].content).toBe('first run')
  })

  it('is a no-op without a folder', () => {
    const { sandbox } = harness()
    expect(sandbox.writeCallArtifact(null, 'x.txt', 'y')).toBe('')
  })
})

describe('manifest', () => {
  it('appends one run entry per stage-A pass and keeps the earlier ones', () => {
    const { sandbox } = harness()
    const folder = fakeFolder('call')

    sandbox.writeManifest(folder, { capture_id: 'dograh-1', runs: [] })
    sandbox.appendManifestRun(folder, { stage: 'transcription', master_coverage: 0.99 })
    sandbox.appendManifestRun(folder, { stage: 'transcription', master_coverage: 0.95 })

    expect(folder.files).toHaveLength(1)
    const manifest = JSON.parse(folder.files[0].content)
    expect(manifest.capture_id).toBe('dograh-1')
    expect(manifest.runs.map((r: { master_coverage: number }) => r.master_coverage)).toEqual([
      0.99, 0.95,
    ])
  })
})

describe('resolveExtractionTranscript', () => {
  function withFile(id: string, content: string) {
    const file = fakeFile('x.txt', content, id)
    return { file, byId: { [id]: file } }
  }

  it('reads the master from Drive and strips speaker labels for the span haystack', () => {
    const { file, byId } = withFile('master-1', 'adjuster: the roof is a six twelve\nagent: got it')
    const { sandbox } = harness({
      DriveApp: { getFileById: (id: string) => byId[id], getFolderById: () => null },
      buildSpanHaystack: (text: string) =>
        text
          .split('\n')
          .map((line) => line.replace(/^(adjuster|agent):\s*/, ''))
          .join('\n'),
    })

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'dograh-1',
      source: 'dograh',
      extraction_input: 'master',
      transcript_master_id: file.getId(),
      transcript: 'dograh text',
    })

    expect(input.source).toBe('master')
    expect(input.transcript).toContain('adjuster: ')
    expect(input.haystack).toBe('the roof is a six twelve\ngot it')
  })

  it('reads the named raw source on a fallback path and uses it as its own haystack', () => {
    const { file, byId } = withFile('eleven-1', 'the roof is a six twelve')
    const { sandbox } = harness({
      DriveApp: { getFileById: (id: string) => byId[id], getFolderById: () => null },
    })

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'dograh-1',
      source: 'dograh',
      extraction_input: 'elevenlabs',
      transcript_elevenlabs_id: file.getId(),
      transcript: 'dograh text',
    })

    expect(input).toEqual({
      source: 'elevenlabs',
      transcript: 'the roof is a six twelve',
      haystack: 'the roof is a six twelve',
    })
  })

  it('degrades to the Dograh transcript when the resolved artifact cannot be read', () => {
    const { sandbox, logged } = harness()

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'dograh-1',
      source: 'dograh',
      extraction_input: 'master',
      transcript_master_id: 'gone',
      transcript: 'dograh text',
    })

    expect(input.source).toBe('dograh')
    expect(input.transcript).toBe('dograh text')
    expect(logged.map((l) => l.event)).toContain('transcription.master_unreadable')
  })

  it('leaves a Telnyx job with no source framing at all', () => {
    const { sandbox } = harness()

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'telnyx-1',
      source: '',
      transcript: 'telnyx text',
    })

    expect(input).toEqual({ source: '', transcript: 'telnyx text', haystack: 'telnyx text' })
  })

  it('resolves a Retell job to its own transcript with the right source label', () => {
    const { sandbox } = harness()

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'retell-1',
      source: 'retell',
      extraction_input: 'retell',
      transcript: 'retell text',
    })

    expect(input).toEqual({ source: 'retell', transcript: 'retell text', haystack: 'retell text' })
  })

  it('degrades a Retell job to its own transcript, not a blank source, when the master is unreadable', () => {
    const { sandbox } = harness()

    const input = sandbox.resolveExtractionTranscript({
      capture_id: 'retell-1',
      source: 'retell',
      extraction_input: 'master',
      transcript_master_id: 'gone',
      transcript: 'retell text',
    })

    expect(input.source).toBe('retell')
    expect(input.transcript).toBe('retell text')
  })
})

describe('runTranscriptionPass', () => {
  const ELEVEN_TEXT = 'the roof is a six twelve with a damaged drip edge'
  const QWEN_TEXT = 'the roof is a 6/12 with a damaged drip edge'

  function passHarness(options: {
    mode?: string
    eleven?: string | null
    qwen?: string | null
    merge?: Record<string, unknown> | null | 'throw'
  }) {
    const folder = fakeFolder('2026-08-26 Henderson dograh-1', 'call-1')
    const root = fakeFolder('root', 'root-1')
    const audio = fakeAudioFile('audio-1')

    // ElevenLabs is phase A on its own fetch; Qwen is phase B through fetchAll.
    // Both stubs answer every time rather than draining a queue, so a 500 that
    // earns a retry gets the same answer twice instead of running dry.
    const elevenResponse =
      options.eleven === null
        ? response(500, 'down')
        : response(200, JSON.stringify({ text: options.eleven ?? ELEVEN_TEXT }))
    const qwenResponse =
      options.qwen === null
        ? response(500, 'down')
        : response(200, JSON.stringify({ text: options.qwen ?? QWEN_TEXT }))

    const built = harness({
      properties: {
        CALL_ARTIFACTS_FOLDER_ID: 'root-1',
        MASTER_TRANSCRIPT_MODE: options.mode ?? 'shadow',
        ELEVENLABS_API_KEY: 'xi',
        OPENROUTER_API_KEY: 'or',
        OPENROUTER_MODEL: 'model-1',
      },
      DriveApp: {
        getFolderById: (id: string) => (id === 'call-1' ? folder : root),
        getFileById: () => audio,
      },
      UrlFetchApp: {
        fetchAll: () => [qwenResponse],
        fetch: (url: string) =>
          String(url).includes('elevenlabs') ? elevenResponse : qwenResponse,
      },
      Utilities: {
        base64Encode: (bytes: number[]) => 'b64-' + bytes.length,
        newBlob: (text: string) => ({ getBytes: () => bytesOf(text) }),
        sleep: () => {},
      },
      loadGlossary: () => [{ term: 'drip edge' }],
      guessAudioExtension: () => 'wav',
      buildGatedMasterTranscript:
        options.merge === 'throw'
          ? () => {
              throw new Error('merge failed')
            }
          : () => options.merge ?? null,
    })

    return { ...built, folder }
  }

  const job = {
    capture_id: 'dograh-1',
    source: 'dograh',
    audio_drive_id: 'audio-1',
    call_folder_id: 'call-1',
    transcript: 'the ruf is a six twelve with a damaged drip hedge',
    match_method: 'exact',
  }
  const claim = { claim_id: 'claim-1', insured_last_name: 'Henderson' }

  const acceptedMerge = {
    accepted: true,
    text: 'adjuster: ' + ELEVEN_TEXT,
    coverage: 1,
    failing: [],
    contested_passages: ['drip edge'],
    model: 'merge-model',
  }

  // ADR 013. Stage A re-entered over unchanged inputs — a hand-edited status, a
  // replayed job — used to buy a second ElevenLabs pass over the same recording.
  // The fingerprint is over what the ASR calls actually read, so a corrected
  // claim match (which changes the keyterms that bias both calls) still
  // re-transcribes.
  describe('idempotency', () => {
    // One live pass, then a second call with the row as the first pass left it.
    function twoPasses(secondJob: Record<string, unknown> = {}) {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, claim)
      const filesAfterFirst = built.folder.files.length

      const second = built.sandbox.runTranscriptionPass({ ...job, ...first, ...secondJob }, claim)

      return { ...built, first, second, filesAfterFirst }
    }

    it('reuses the stored pass instead of re-transcribing unchanged inputs', () => {
      const { first, second, folder, filesAfterFirst, logged } = twoPasses()

      expect(second).toEqual(first)
      expect(folder.files).toHaveLength(filesAfterFirst)
      expect(logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(1)
      expect(logged.find((l) => l.event === 'transcription.reused')?.fields.extraction_input).toBe(
        'master',
      )
    })

    it('carries the fingerprint on the fields it writes to the row', () => {
      const { first } = twoPasses()

      expect(String(first.transcription_fingerprint)).not.toBe('')
    })

    // The case an "artifacts exist, skip" guard would have got wrong: the audio
    // is identical, but a corrected claim changes the keyterms that bias the ASR.
    it('re-transcribes when the matched claim changes the keyterms', () => {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, claim)

      built.sandbox.runTranscriptionPass({ ...job, ...first }, {
        claim_id: 'claim-2',
        insured_last_name: 'Okafor',
      } as never)

      expect(built.logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
      expect(built.logged.some((l) => l.event === 'transcription.reused')).toBe(false)
    })

    it('re-transcribes when the audio changes', () => {
      const { logged } = twoPasses({ audio_drive_id: 'audio-2' })

      expect(logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
    })

    it('re-transcribes when the mode flips, since it decides extraction_input', () => {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, claim)

      built.properties.MASTER_TRANSCRIPT_MODE = 'shadow'
      const second = built.sandbox.runTranscriptionPass({ ...job, ...first }, claim)

      expect(second.extraction_input).toBe('dograh')
      expect(built.logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
    })

    it('re-transcribes a row that has no fingerprint yet', () => {
      const { logged } = twoPasses({ transcription_fingerprint: '' })

      expect(logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
    })

    // The cache key covers the whole pass, so it has to cover the merge's inputs
    // too — the merge prompt renders the claim and glossary in full and runs on
    // its own model. Keyterms are not a proxy: sanitizeKeyterm caps terms at five
    // words and the list at 1000, and definitions never reach the keyterms.
    it('re-transcribes when the merge model changes', () => {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, claim)

      built.properties.MASTER_TRANSCRIPT_MODEL = 'some/other-merge-model'
      built.sandbox.runTranscriptionPass({ ...job, ...first }, claim)

      expect(built.logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
    })

    it('re-transcribes when a glossary definition changes but its term does not', () => {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, claim)

      built.sandbox.loadGlossary = () => [{ term: 'drip edge', definition: 'the metal flashing' }]
      built.sandbox.runTranscriptionPass({ ...job, ...first }, claim)

      expect(built.logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
    })

    // Churn the merge does not care about must NOT re-buy two ASR passes.
    // property_lookup_at moves whenever a calendar tick runs a property lookup
    // (docs/specs/027) and _rowIndex moves when a row moves up the sheet.
    it('reuses across claim-row bookkeeping the merge gains nothing from', () => {
      const built = passHarness({ mode: 'live', merge: acceptedMerge })
      const first = built.sandbox.runTranscriptionPass({ ...job }, { ...claim, _rowIndex: 4 })

      built.sandbox.runTranscriptionPass(
        { ...job, ...first },
        { ...claim, _rowIndex: 9, property_lookup_at: '2026-09-15T18:00:00Z' },
      )

      expect(built.logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(1)
      expect(built.logged.some((l) => l.event === 'transcription.reused')).toBe(true)
    })

    // sanitizeKeyterm's banned-character list does not include '|', so a joined
    // serialization would hash ['A|B'] and ['A', 'B'] identically.
    it('does not confuse keyterm lists that differ only in where they split', () => {
      const { sandbox } = harness()

      expect(
        sandbox.transcriptionInputsFingerprint({ mode: 'live', job: {}, keyterms: ['A|B'] }),
      ).not.toBe(
        sandbox.transcriptionInputsFingerprint({ mode: 'live', job: {}, keyterms: ['A', 'B'] }),
      )
    })

    // retranscribeJob empties the transcription columns and re-queues stage A.
    // Its fingerprint used to survive that, so the next pass matched, reused the
    // blanks, and the operator's explicit request vanished.
    it('does not reuse a row whose transcription was deliberately cleared', () => {
      const { logged } = twoPasses({ extraction_input: '', transcript_master_id: '' })

      expect(logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
      expect(logged.find((l) => l.event === 'transcription.reuse_rejected')?.fields.reason).toBe(
        'no_extraction_input',
      )
    })

    // A fingerprint match over a master somebody deleted out of Drive would hand
    // extraction an id resolving to nothing — worse than paying again.
    it('re-transcribes when the artifact the fingerprint vouches for is gone', () => {
      const { logged } = twoPasses({ transcript_master: '', transcript_master_id: 'deleted-1' })

      expect(logged.filter((l) => l.event === 'transcription.pass_complete')).toHaveLength(2)
      expect(logged.find((l) => l.event === 'transcription.reuse_rejected')?.fields.reason).toBe(
        'artifact_unreadable',
      )
    })
  })

  // The escape hatch for what the fingerprint cannot see: same audio, same claim,
  // simply a bad transcription.
  describe('forceRetranscribe', () => {
    function forceHarness(row: Record<string, unknown> | null) {
      const writes: Array<Record<string, unknown>> = []
      const ensured: string[][] = []
      const built = harness({
        getJobByCaptureId: () => row,
        upsertJob: (_id: string, fields: Record<string, unknown>) => writes.push(fields),
        ensureJobsColumns: (columns: string[]) => {
          ensured.push(columns)
          return []
        },
      })
      return { ...built, writes, ensured }
    }

    it('clears the fingerprint and returns the job to stage A', () => {
      const { sandbox, writes } = forceHarness({
        capture_id: 'dograh-1',
        status: 'done',
        transcription_fingerprint: 'fp-1',
      })

      sandbox.forceRetranscribe('dograh-1')

      expect(writes[0]).toMatchObject({
        status: 'pending',
        transcription_fingerprint: '',
        attempts: 0,
      })
    })

    // The column postdates every Jobs sheet in existence; without this the
    // documented override throws Missing column until the next drain runs.
    it('ensures the fingerprint column exists before writing to it', () => {
      const { sandbox, ensured } = forceHarness({ capture_id: 'dograh-1', status: 'done' })

      sandbox.forceRetranscribe('dograh-1')

      expect(ensured[0]).toContain('transcription_fingerprint')
    })

    // A drain holding a lease on this row can otherwise finish after the write
    // and overwrite the cleared fingerprint with its own result.
    it('takes the job lock around the read and the write', () => {
      const order: string[] = []
      const { sandbox } = harness({
        getJobByCaptureId: () => ({ capture_id: 'dograh-1', status: 'done' }),
        ensureJobsColumns: () => [],
        upsertJob: () => order.push('write'),
        withJobLock: (fn: () => unknown) => {
          order.push('lock')
          const result = fn()
          order.push('release')
          return result
        },
      })

      sandbox.forceRetranscribe('dograh-1')

      expect(order).toEqual(['lock', 'write', 'release'])
    })

    it('refuses a capture_id that is not on the Jobs tab', () => {
      const { sandbox } = forceHarness(null)

      expect(() => sandbox.forceRetranscribe('nope')).toThrow('No job for capture_id')
    })
  })

  it('skips everything and leaves extraction on Dograh when the mode is off', () => {
    const { sandbox, folder, logged } = passHarness({ mode: 'off' })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields).toEqual({ extraction_input: 'dograh' })
    expect(folder.files).toHaveLength(0)
    expect(logged.find((l) => l.event === 'transcription.skipped')?.fields.reason).toBe('mode_off')
  })

  it('leaves a Telnyx job entirely alone', () => {
    const { sandbox, logged } = passHarness({})

    const fields = sandbox.runTranscriptionPass({ ...job, source: 'telnyx' }, claim)

    expect(fields).toEqual({})
    expect(logged.find((l) => l.event === 'transcription.skipped')?.fields.reason).toBe(
      'unsupported_source',
    )
  })

  it('runs the full pass for a Retell job exactly like a Dograh one', () => {
    const { sandbox, folder } = passHarness({ mode: 'live', merge: acceptedMerge })

    const fields = sandbox.runTranscriptionPass({ ...job, source: 'retell' }, claim)

    expect(fields.transcription_sources).toBe('elevenlabs,qwen,retell')
    expect(fields.extraction_input).toBe('master')
    expect(folder.files.map((f) => f.name)).toEqual([
      'transcript-elevenlabs.txt',
      'transcript-qwen.txt',
      'transcript-master.txt',
      'manifest.json',
    ])
  })

  it('points a Retell job at its own live transcript when the gate rejects the master', () => {
    const { sandbox } = passHarness({
      mode: 'live',
      merge: { ...acceptedMerge, accepted: false, coverage: 0.4 },
    })

    const fields = sandbox.runTranscriptionPass({ ...job, source: 'retell' }, claim)

    expect(fields.extraction_input).toBe('elevenlabs')
  })

  it('leaves extraction on the Retell transcript in shadow mode', () => {
    const { sandbox } = passHarness({ merge: acceptedMerge })

    const fields = sandbox.runTranscriptionPass({ ...job, source: 'retell' }, claim)

    expect(fields.extraction_input).toBe('retell')
  })

  it('rides on the Retell transcript alone when both ASR sources die', () => {
    const { sandbox } = passHarness({ mode: 'live', eleven: null, qwen: null })

    const fields = sandbox.runTranscriptionPass({ ...job, source: 'retell' }, claim)

    expect(fields.transcription_sources).toBe('retell')
    expect(fields.extraction_input).toBe('retell')
  })

  it('records voice_platform on the manifest run for both platforms', () => {
    const dograhRun = passHarness({ mode: 'live', merge: acceptedMerge })
    dograhRun.sandbox.runTranscriptionPass(job, claim)
    const dograhManifest = JSON.parse(
      dograhRun.folder.files.find((f) => f.name === 'manifest.json')!.content,
    )
    expect(dograhManifest.runs[0].voice_platform).toBe('dograh')

    const retellRun = passHarness({ mode: 'live', merge: acceptedMerge })
    retellRun.sandbox.runTranscriptionPass({ ...job, source: 'retell' }, claim)
    const retellManifest = JSON.parse(
      retellRun.folder.files.find((f) => f.name === 'manifest.json')!.content,
    )
    expect(retellManifest.runs[0].voice_platform).toBe('retell')
  })

  it('skips a Dograh job whose recording never made it to Drive', () => {
    const { sandbox, logged } = passHarness({})

    const fields = sandbox.runTranscriptionPass({ ...job, audio_drive_id: '' }, claim)

    expect(fields).toEqual({ extraction_input: 'dograh' })
    expect(logged.find((l) => l.event === 'transcription.skipped')?.fields.reason).toBe('no_audio')
  })

  it('writes every artifact but leaves extraction on Dograh in shadow mode', () => {
    const { sandbox, folder } = passHarness({ merge: acceptedMerge })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(folder.files.map((f) => f.name)).toEqual([
      'transcript-elevenlabs.txt',
      'transcript-qwen.txt',
      'transcript-master.txt',
      'manifest.json',
    ])
    expect(fields.transcription_sources).toBe('elevenlabs,qwen,dograh')
    expect(fields.master_coverage).toBe(1)
    expect(fields.extraction_input).toBe('dograh')
  })

  it('points extraction at the master in live mode', () => {
    const { sandbox } = passHarness({ mode: 'live', merge: acceptedMerge })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields.extraction_input).toBe('master')
    expect(fields.transcript_master).toBe('adjuster: ' + ELEVEN_TEXT)
  })

  it('points extraction at the highest-precedence raw source when the gate rejects the master', () => {
    const { sandbox, folder } = passHarness({
      mode: 'live',
      merge: { ...acceptedMerge, accepted: false, coverage: 0.4 },
    })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields.extraction_input).toBe('elevenlabs')
    // The rejected master stays in the call folder for inspection.
    expect(folder.files.map((f) => f.name)).toContain('transcript-master.txt')
  })

  it('merges on two sources and says which one was lost', () => {
    const { sandbox, logged } = passHarness({ mode: 'live', qwen: null, merge: acceptedMerge })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields.transcription_sources).toBe('elevenlabs,dograh')
    expect(logged.find((l) => l.event === 'transcription.degraded')?.fields.lost).toBe('qwen')
    expect(fields.extraction_input).toBe('master')
  })

  it('skips the merge entirely and rides on Dograh when both ASR sources die', () => {
    const { sandbox, logged } = passHarness({ mode: 'live', eleven: null, qwen: null })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields.transcription_sources).toBe('dograh')
    expect(fields.transcript_master).toBe('')
    expect(fields.extraction_input).toBe('dograh')
    expect(logged.map((l) => l.event)).toContain('transcription.single_source')
  })

  it('degrades to a raw transcript rather than failing when the merge call throws', () => {
    const { sandbox, logged } = passHarness({ mode: 'live', merge: 'throw' })

    const fields = sandbox.runTranscriptionPass(job, claim)

    expect(fields.extraction_input).toBe('elevenlabs')
    expect(logged.map((l) => l.event)).toContain('master_transcript.call_failed')
  })

  it('records the run in the manifest, contested passages included', () => {
    const { sandbox, folder } = passHarness({ mode: 'live', merge: acceptedMerge })

    sandbox.runTranscriptionPass(job, claim)

    const manifest = JSON.parse(folder.files.find((f) => f.name === 'manifest.json')!.content)
    expect(manifest.runs).toHaveLength(1)
    expect(manifest.runs[0]).toMatchObject({
      mode: 'live',
      capture_id: 'dograh-1',
      claim_id: 'claim-1',
      master_accepted: true,
      master_coverage: 1,
      contested_passages: ['drip edge'],
      extraction_input: 'master',
    })
    expect(manifest.runs[0].sources.map((s: { source: string }) => s.source)).toEqual([
      'elevenlabs',
      'qwen',
      'dograh',
    ])
  })
})

describe('retranscribeJob', () => {
  it('clears the transcription columns, keeps the call folder, and re-queues stage A', () => {
    const written: Record<string, unknown>[] = []
    const { sandbox } = harness({
      getJobByCaptureId: () => ({
        capture_id: 'dograh-1',
        status: 'done',
        call_folder_id: 'folder-9',
      }),
      upsertJob: (_id: string, fields: Record<string, unknown>) => written.push(fields),
      ensureJobsColumns: () => [],
    })

    expect(sandbox.retranscribeJob('dograh-1')).toBe(true)
    expect(written[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      transcript_master: '',
      transcript_master_id: '',
      extraction_input: '',
      // ADR 013. A fingerprint surviving the clearing would let the next pass
      // match, reuse the blanks, and swallow the retranscribe just requested.
      transcription_fingerprint: '',
    })
    expect(written[0]).not.toHaveProperty('call_folder_id')
  })

  it('throws on a capture id that has no job', () => {
    const { sandbox } = harness({ getJobByCaptureId: () => null })

    expect(() => sandbox.retranscribeJob('nope')).toThrow('No job for capture_id: nope')
  })
})

describe('unconfigured vendors', () => {
  const elevenBody = JSON.stringify({ text: 'the roof is a six twelve' })

  function keyHarness(properties: Record<string, string>) {
    const folder = fakeFolder('call', 'call-1')
    const root = fakeFolder('root', 'root-1')

    return {
      ...harness({
        properties: { CALL_ARTIFACTS_FOLDER_ID: 'root-1', ...properties },
        DriveApp: {
          getFolderById: (id: string) => (id === 'call-1' ? folder : root),
          getFileById: () => ({
            getName: () => 'audio.wav',
            getBlob: () => wavBlob(makeWav({ seconds: 1 })),
          }),
        },
        UrlFetchApp: { fetchAll: () => [response(200, elevenBody)], fetch: () => null },
        Utilities: {
          base64Encode: (bytes: number[]) => 'b64-' + bytes.length,
          newBlob: (text: string) => ({ getBytes: () => bytesOf(text) }),
          sleep: () => {},
        },
        loadGlossary: () => [],
        guessAudioExtension: () => 'wav',
        buildGatedMasterTranscript: () => null,
      }),
      folder,
    }
  }

  const job = {
    capture_id: 'dograh-1',
    source: 'dograh',
    audio_drive_id: 'audio-1',
    call_folder_id: 'call-1',
    transcript: 'dograh text',
  }

  it('loses only that source when ELEVENLABS_API_KEY has not been set yet', () => {
    const { sandbox, logged } = keyHarness({
      MASTER_TRANSCRIPT_MODE: 'shadow',
      OPENROUTER_API_KEY: 'or',
      OPENROUTER_MODEL: 'model-1',
    })

    const fields = sandbox.runTranscriptionPass(job, null)

    expect(fields.transcription_sources).toBe('qwen,dograh')
    expect(logged.find((l) => l.event === 'transcription.source_unconfigured')?.fields.source).toBe(
      'elevenlabs',
    )
  })

  it('rides on the Dograh transcript when neither vendor is configured', () => {
    const { sandbox } = keyHarness({ MASTER_TRANSCRIPT_MODE: 'live' })

    const fields = sandbox.runTranscriptionPass(job, null)

    expect(fields.transcription_sources).toBe('dograh')
    expect(fields.extraction_input).toBe('dograh')
  })
})
