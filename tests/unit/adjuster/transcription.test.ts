import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

type Folder = ReturnType<typeof fakeFolder>

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

function response(status: number, body: string) {
  return { getResponseCode: () => status, getContentText: () => body }
}

const SOURCES = 'apps/adjuster/src/transcription.js'

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

  const sandbox = loadGs([SOURCES], {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    describeError: (err: Error) => ({ error: String(err.message ?? err), stack: '' }),
    getConfig: (key: string) => {
      if (properties[key] === undefined) throw new Error('Missing script property: ' + key)
      return properties[key]
    },
    getOptionalConfig: (key: string, fallback: string) =>
      properties[key] === undefined ? fallback : properties[key],
    getConfigList: () => [],
    DriveApp: {
      getFolderById: (id: string) => {
        if (!foldersById[id]) throw new Error('No folder ' + id)
        return foldersById[id]
      },
      getFileById: (id: string) => {
        if (!filesById[id]) throw new Error('No file ' + id)
        return filesById[id]
      },
    },
    Utilities: {
      base64Encode: () => 'AAAA',
      sleep: () => {},
    },
    UrlFetchApp: { fetchAll: () => [], fetch: () => null },
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

  it('caps at 1000 terms and 50 characters each', () => {
    const { sandbox } = harness()
    const glossary = Array.from({ length: 1200 }, (_, i) => ({ term: 'term-' + i }))

    const terms = sandbox.buildKeyterms({ city: 'x'.repeat(80) }, glossary, 'Brandon')

    expect(terms).toHaveLength(1000)
    expect(terms[0]).toHaveLength(50)
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
})

describe('transcribeInParallel', () => {
  function asrHarness(fetchAll: (requests: unknown[]) => unknown[], fetch = () => null) {
    return harness({ UrlFetchApp: { fetchAll: vi.fn(fetchAll), fetch: vi.fn(fetch) } })
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

  function run(sandbox: Record<string, any>) {
    return sandbox.transcribeInParallel({
      captureId: 'dograh-1',
      audioBlob: { getBytes: () => [1, 2, 3] },
      format: 'wav',
      keyterms: ['Henderson'],
      elevenLabsKey: 'xi-key',
      openRouterKey: 'or-key',
    })
  }

  it('issues both ASR calls in a single fetchAll with two request objects', () => {
    const { sandbox } = asrHarness(() => [response(200, elevenBody), response(200, qwenBody)])

    const result = run(sandbox)

    const fetchAll = sandbox.UrlFetchApp.fetchAll as ReturnType<typeof vi.fn>
    expect(fetchAll).toHaveBeenCalledTimes(1)
    const requests = fetchAll.mock.calls[0][0]
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toContain('api.elevenlabs.io')
    expect(requests[0].headers['xi-api-key']).toBe('xi-key')
    expect(requests[0].payload.model_id).toBe('scribe_v2')
    expect(requests[0].payload.diarize).toBe('true')
    expect(JSON.parse(requests[0].payload.keyterms)).toEqual(['Henderson'])
    expect(requests[1].url).toContain('openrouter.ai/api/v1/audio/transcriptions')
    expect(JSON.parse(requests[1].payload).provider.options.alibaba.context).toBe('Henderson')
    expect(result.fetch_mode).toBe('fetch_all')
    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.qwen.text).toBe('the roof is a 6/12')
  })

  it('turns the diarized words array into speaker turns', () => {
    const { sandbox } = asrHarness(() => [response(200, elevenBody), response(200, qwenBody)])

    const result = run(sandbox)

    expect(result.elevenlabs.turns).toEqual([
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
    const { sandbox } = asrHarness(() => responses)

    const result = run(sandbox)
    const alive = dead === 'elevenlabs' ? 'qwen' : 'elevenlabs'

    expect(result[dead].text).toBe('')
    expect(result[dead].ok).toBe(false)
    expect(result[alive].text).not.toBe('')
  })

  it.each([
    ['elevenlabs', 0],
    ['qwen', 1],
  ])("logs %s's error body so a 400 is debuggable after the fact", (dead, index) => {
    const detail = JSON.stringify({ detail: [{ loc: ['body', 'file'], msg: 'audio too short' }] })
    const responses = [response(200, elevenBody), response(200, qwenBody)]
    responses[index] = response(400, detail)
    const { sandbox, logged } = asrHarness(() => responses)

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
    const { sandbox, logged } = asrHarness(() => [
      response(200, elevenBody),
      response(400, 'x'.repeat(5000)),
    ])

    run(sandbox)

    const qwen = logged
      .filter((l) => l.event === 'transcription.source_finished')
      .find((l) => l.fields.source === 'qwen')
    expect(String(qwen?.fields.error)).toHaveLength(2000)
  })

  it('retries a single source once on a 429 rather than failing it outright', () => {
    const { sandbox } = asrHarness(
      () => [response(429, 'slow down'), response(200, qwenBody)],
      () => response(200, elevenBody) as never,
    )

    const result = run(sandbox)

    expect(sandbox.UrlFetchApp.fetch).toHaveBeenCalledTimes(1)
    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
  })

  it('falls back to sequential fetches when fetchAll itself throws', () => {
    const bodies = [elevenBody, qwenBody]
    let call = 0
    const { sandbox, logged } = asrHarness(
      () => {
        throw new Error('transport blew up')
      },
      (() => response(200, bodies[call++])) as never,
    )

    const result = run(sandbox)

    expect(result.fetch_mode).toBe('sequential')
    expect(result.elevenlabs.text).toBe('the roof is a six twelve')
    expect(result.qwen.text).toBe('the roof is a 6/12')
    expect(logged.map((l) => l.event)).toContain('transcription.fetch_all_failed')
  })

  it('skips Qwen and says so when the base64 audio would blow the payload cap', () => {
    const { sandbox, logged } = harness({
      UrlFetchApp: { fetchAll: vi.fn(() => [response(200, elevenBody)]), fetch: vi.fn() },
      Utilities: { base64Encode: () => 'a'.repeat(36 * 1024 * 1024), sleep: () => {} },
    })

    const result = run(sandbox)

    const requests = (sandbox.UrlFetchApp.fetchAll as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(requests).toHaveLength(1)
    expect(result.qwen).toBeUndefined()
    expect(logged.map((l) => l.event)).toContain('transcription.audio_too_large')
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
    const audio = { getName: () => 'audio.wav', getBlob: () => ({ getBytes: () => [1] }) }

    const responses: unknown[] = []
    if (options.eleven === null) responses.push(response(500, 'down'))
    else responses.push(response(200, JSON.stringify({ text: options.eleven ?? ELEVEN_TEXT })))
    if (options.qwen === null) responses.push(response(500, 'down'))
    else responses.push(response(200, JSON.stringify({ text: options.qwen ?? QWEN_TEXT })))

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
      UrlFetchApp: { fetchAll: () => responses, fetch: () => null },
      Utilities: { base64Encode: () => 'AAAA', sleep: () => {} },
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
      'not_dograh',
    )
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
            getBlob: () => ({ getBytes: () => [1] }),
          }),
        },
        UrlFetchApp: { fetchAll: () => [response(200, elevenBody)], fetch: () => null },
        Utilities: { base64Encode: () => 'AAAA', sleep: () => {} },
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
