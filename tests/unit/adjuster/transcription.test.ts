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

function response(status: number, body: string) {
  return { getResponseCode: () => status, getContentText: () => body }
}

// The adapter half: the per-call Drive folder, its artifacts, the manifest, and
// the stage-A orchestration. Core's own half — keyterms, request building, WAV
// slicing, response parsing, the fan-out — is exercised in
// coreTranscription.test.ts. Both halves load here, together with the real
// coreDeps.js, so these tests run the actual adapter wiring rather than a stub
// of it: buildCoreDeps() below is production code reading the Apps Script
// globals this harness fakes.
const SOURCES = [
  'apps/adjuster/src/core/deps.js',
  'apps/adjuster/src/core/transcription.js',
  'apps/adjuster/src/coreDeps.js',
  'apps/adjuster/src/transcription.js',
]

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
    logServerOnly: () => {},
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
      base64Encode: (bytes: number[]) => 'b64-' + bytes.length,
      newBlob: (text: string) => ({ getBytes: () => bytesOf(text) }),
      sleep: () => {},
    },
    UrlFetchApp: { fetchAll: () => [], fetch: () => null },
    ...overrides,
  })

  return { sandbox, logged, root, filesById, foldersById, properties }
}

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
    const audio = { getName: () => 'audio.wav', getBlob: () => wavBlob(makeWav({ seconds: 1 })) }

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
