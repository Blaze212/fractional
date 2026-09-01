import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

const SECRET = 'shared-secret'
const CAPTURE = '410b941e-9c3a-11f1-9361-52d0a1d78284'
const RETELL_API_KEY = 'retell-api-key-test'

type Job = Record<string, unknown>

function harness(overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>()
  const raw: Array<{ event: string; body: string }> = []
  const logged: string[] = []
  const lock = { held: 0, maxHeld: 0 }

  const sandbox = loadGs(
    ['apps/adjuster/src/log.js', 'apps/adjuster/src/webhook.js', 'apps/adjuster/src/guidedFlow.js'],
    {
      console: {
        log: (line: string) => logged.push(line),
        error: (line: string) => logged.push(line),
      },
      getConfig: (key: string) => {
        if (key === 'WEBHOOK_SECRET') return SECRET
        if (key === 'RECORDINGS_FOLDER_ID') return 'folder-1'
        if (key === 'RETELL_API_KEY') return RETELL_API_KEY
        throw new Error('Missing script property: ' + key)
      },
      getConfigList: () => ['+18176762145'],
      appendRaw: (event: string, body: string) => raw.push({ event, body }),
      getJobByCaptureId: (id: string) => jobs.get(id) ?? null,
      upsertJob: (id: string, fields: Job) => {
        jobs.set(id, { ...(jobs.get(id) ?? {}), ...fields })
      },
      withJobLock: (fn: () => unknown) => {
        lock.held += 1
        lock.maxHeld = Math.max(lock.maxHeld, lock.held)
        try {
          return fn()
        } finally {
          lock.held -= 1
        }
      },
      ContentService: {
        MimeType: { XML: 'XML', JSON: 'JSON' },
        createTextOutput: (body: string) => ({ body, setMimeType: () => ({ body }) }),
      },
      getClaims: () => [],
      ensureJobsColumns: () => [],
      JOBS_TRANSCRIPTION_COLUMNS: ['call_folder_id'],
      // Loaded from transcription.js at runtime; stubbed off by default here so
      // the flat-folder path stays covered. The call-folder suite injects real
      // ones.
      getOrCreateCallFolder: () => null,
      writeCallArtifact: () => '',
      writeManifest: () => '',
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName: () => 'blob' }) }),
      },
      DriveApp: { getFolderById: () => ({ createFile: () => ({ getId: () => 'drive-1' }) }) },
      Utilities: {
        base64Decode: (value: string) => Buffer.from(value, 'base64'),
        newBlob: (bytes: Buffer) => ({
          getDataAsString: () => Buffer.from(bytes).toString('utf-8'),
        }),
        computeHmacSha256Signature: (value: string, key: string) =>
          Array.from(crypto.createHmac('sha256', key).update(value).digest()),
      },
      ...overrides,
    },
  )

  return { sandbox, jobs, raw, logged, lock }
}

function post(params: Record<string, string>) {
  return { parameter: { t: SECRET, ...params } }
}

function events(logged: string[]) {
  return logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
}

describe('doPost logging contract', () => {
  it('logs a received line and an accepted line for a valid recording callback', () => {
    const { sandbox, logged } = harness()

    sandbox.doPost(
      post({
        event: 'recording',
        CallSessionId: CAPTURE,
        From: '+18176762145',
        RecordingUrl: 'https://s3/x.mp3',
      }),
    )

    expect(events(logged)).toEqual(['webhook.received', 'webhook.accepted'])
  })

  it.each([
    ['bad_secret', { t: 'wrong', event: 'recording', CallSessionId: CAPTURE }],
    ['bad_call_session_id', { event: 'recording', CallSessionId: 'short' }],
    ['caller_not_allowed', { event: 'recording', CallSessionId: CAPTURE, From: '+15550000000' }],
    ['unknown_event', { CallSessionId: CAPTURE, From: '+18176762145' }],
  ])('logs a denied line with reason %s', (reason, params) => {
    const { sandbox, logged } = harness()

    sandbox.doPost({ parameter: { t: SECRET, ...params } })

    const lines = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    expect(lines.map((l) => l.event)).toEqual(['webhook.received', 'webhook.denied'])
    expect(lines[1].reason).toBe(reason)
  })

  it('logs a failed line with the error and stack when an accepted request throws', () => {
    const { sandbox, logged } = harness({
      upsertJob: () => {
        throw new Error('Missing column: transcript')
      },
    })

    sandbox.doPost(
      post({ event: 'transcription', CallSessionId: CAPTURE, TranscriptionText: 'hello' }),
    )

    const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
    expect(terminal.event).toBe('webhook.failed')
    expect(terminal.reason).toBe('Missing column: transcript')
    expect(terminal.stack).toContain('Error')
  })

  it('still logs to console when the Raw sheet write throws', () => {
    const { sandbox, logged } = harness({
      appendRaw: () => {
        throw new Error('Missing column: raw_body')
      },
    })

    sandbox.doPost(post({ event: 'action', CallSessionId: CAPTURE, From: '+18176762145' }))

    expect(events(logged)).toEqual(['webhook.received', 'webhook.accepted'])
    expect(logged.some((l) => l.startsWith('raw_sheet_write_failed'))).toBe(true)
  })

  it('logs a failure rather than throwing when the webhook secret is unset', () => {
    const { sandbox, logged } = harness({
      getConfig: () => {
        throw new Error('Missing script property: WEBHOOK_SECRET')
      },
    })

    sandbox.doPost(post({ event: 'recording', CallSessionId: CAPTURE }))

    const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
    expect(terminal.event).toBe('webhook.failed')
    expect(terminal.reason).toBe('Missing script property: WEBHOOK_SECRET')
  })

  it('redacts the shared secret and reports the raw parameter names', () => {
    const { sandbox, logged } = harness()

    sandbox.doPost(post({ event: 'recording', CallSessionId: CAPTURE, From: '+18176762145' }))

    const received = JSON.parse(logged.filter((l) => l.startsWith('{'))[0])
    expect(received.params.t).toBe('[redacted]')
    expect(JSON.stringify(received)).not.toContain(SECRET)
    expect(received.param_names).toBe('CallSessionId,From,event,t')
  })
})

describe('transcript persistence', () => {
  it('keeps the transcript when the recording callback lands after it', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(
      post({ event: 'transcription', CallSessionId: CAPTURE, TranscriptionText: 'roof is 3-tab' }),
    )
    sandbox.doPost(
      post({
        event: 'recording',
        CallSessionId: CAPTURE,
        From: '+18176762145',
        RecordingUrl: 'https://s3/x.mp3',
        RecordingDuration: '13',
      }),
    )

    const job = jobs.get(CAPTURE)!
    expect(job.transcript).toBe('roof is 3-tab')
    expect(job.audio_drive_id).toBe('drive-1')
    expect(job.status).toBe('pending')
  })

  it('marks the job pending when the transcript lands after the recording', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(
      post({
        event: 'recording',
        CallSessionId: CAPTURE,
        From: '+18176762145',
        RecordingUrl: 'https://s3/x.mp3',
      }),
    )
    sandbox.doPost(
      post({ event: 'transcription', CallSessionId: CAPTURE, TranscriptionText: 'roof is 3-tab' }),
    )

    expect(jobs.get(CAPTURE)!.status).toBe('pending')
  })

  it('never leaves a transcript-only job with a blank status', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(
      post({ event: 'transcription', CallSessionId: CAPTURE, TranscriptionText: 'roof is 3-tab' }),
    )

    expect(jobs.get(CAPTURE)!.status).toBe('awaiting_recording')
  })

  it('takes the job lock for every sheet mutation', () => {
    const { sandbox, lock } = harness()

    sandbox.doPost(post({ event: 'transcription', CallSessionId: CAPTURE, TranscriptionText: 'x' }))

    expect(lock.maxHeld).toBe(1)
    expect(lock.held).toBe(0)
  })
})

describe('duplicate recording callbacks', () => {
  const recording = (duration: string, url: string) =>
    post({
      event: 'recording',
      CallSessionId: CAPTURE,
      From: '+18176762145',
      RecordingUrl: url,
      RecordingDuration: duration,
    })

  it('keeps the longer recording when the shorter one arrives second', () => {
    const { sandbox, jobs, logged } = harness()

    sandbox.doPost(recording('13', 'https://s3/long.mp3'))
    sandbox.doPost(recording('9', 'https://s3/short.mp3'))

    expect(jobs.get(CAPTURE)!.duration_sec).toBe(13)
    expect(jobs.get(CAPTURE)!.recording_url).toBe('https://s3/long.mp3')
    expect(events(logged)).toContain('webhook.recording_superseded')
  })

  it('replaces the recording when a longer one arrives second', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(recording('9', 'https://s3/short.mp3'))
    sandbox.doPost(recording('13', 'https://s3/long.mp3'))

    expect(jobs.get(CAPTURE)!.duration_sec).toBe(13)
    expect(jobs.get(CAPTURE)!.recording_url).toBe('https://s3/long.mp3')
  })

  it('does not copy the superseded recording to Drive a second time', () => {
    const fetch = vi.fn(() => ({
      getResponseCode: () => 200,
      getBlob: () => ({ setName: () => 'blob' }),
    }))
    const { sandbox } = harness({ UrlFetchApp: { fetch } })

    sandbox.doPost(recording('13', 'https://s3/long.mp3'))
    sandbox.doPost(recording('9', 'https://s3/short.mp3'))

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('Dograh Notetaker recording', () => {
  function dograhPost(body: Record<string, unknown>) {
    return {
      parameter: { t: SECRET, event: 'dograh_notetaker' },
      postData: { type: 'application/json', contents: JSON.stringify(body) },
    }
  }

  function dograhHarness(overrides: Record<string, unknown> = {}) {
    return harness({
      loadEnums: () => ({}),
      validateLiveFields: () => ({}),
      ...overrides,
    })
  }

  it('copies the recording into Drive and stores audio_drive_id, not just the raw URL', () => {
    const { sandbox, jobs } = dograhHarness()

    sandbox.doPost(
      dograhPost({
        capture_id: 'dograh-run-1',
        recording_url: 'https://dograh.example/audio/run-1.mp3',
        transcript_url: '',
        duration_sec: 90,
      }),
    )

    const job = jobs.get('dograh-run-1')!
    expect(job.audio_drive_id).toBe('drive-1')
    expect(job.recording_url).toBe('https://dograh.example/audio/run-1.mp3')
  })

  it.each([
    ['https://dograh.example/audio.mp3', 'dograh-run-2.mp3'],
    ['https://dograh.example/audio', 'dograh-run-3.wav'],
  ])('names the Drive copy %s as %s, defaulting to wav with no extension', (url, expectedName) => {
    const setName = vi.fn((name: string) => name)
    const { sandbox } = dograhHarness({
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName }) }) },
    })
    const captureId = expectedName.replace(/\.\w+$/, '')

    sandbox.doPost(dograhPost({ capture_id: captureId, recording_url: url }))

    expect(setName).toHaveBeenCalledWith(expectedName)
  })

  it('does not attempt a Drive copy when there is no recording_url', () => {
    const fetch = vi.fn(() => ({
      getResponseCode: () => 200,
      getBlob: () => ({ setName: () => 'blob' }),
    }))
    const { sandbox, jobs } = dograhHarness({ UrlFetchApp: { fetch } })

    sandbox.doPost(dograhPost({ capture_id: 'dograh-run-4', recording_url: '' }))

    expect(fetch).not.toHaveBeenCalled()
    expect(jobs.get('dograh-run-4')!.audio_drive_id).toBe('')
  })

  it('leaves audio_drive_id empty when the recording fetch fails, without failing the whole job', () => {
    const { sandbox, jobs } = dograhHarness({
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 403 }) },
    })

    sandbox.doPost(
      dograhPost({ capture_id: 'dograh-run-5', recording_url: 'https://dograh.example/gone.mp3' }),
    )

    const job = jobs.get('dograh-run-5')!
    expect(job.audio_drive_id).toBe('')
    expect(job.status).toBe('pending')
  })

  describe('per-call artifact folder', () => {
    function folderHarness(overrides: Record<string, unknown> = {}) {
      const artifacts: Array<{ name: string; content: string }> = []
      const manifests: Record<string, unknown>[] = []
      const setName = vi.fn((name: string) => name)
      const createFile = vi.fn(() => ({ getId: () => 'audio-file-1' }))
      const callFolder = { getId: () => 'call-folder-1', createFile }

      const built = dograhHarness({
        getOrCreateCallFolder: vi.fn(() => callFolder),
        writeCallArtifact: (_folder: unknown, name: string, content: string) => {
          artifacts.push({ name, content })
          return 'artifact-' + name
        },
        writeManifest: (_folder: unknown, manifest: Record<string, unknown>) => {
          manifests.push(manifest)
          return 'manifest-1'
        },
        UrlFetchApp: {
          fetch: () => ({
            getResponseCode: () => 200,
            getContentText: () => 'the roof is a six twelve',
            getBlob: () => ({ setName }),
          }),
        },
        DriveApp: {
          getFolderById: vi.fn(() => ({ createFile: () => ({ getId: () => 'flat-1' }) })),
        },
        ...overrides,
      })

      return { ...built, artifacts, manifests, setName, createFile }
    }

    it('puts the audio in the call folder as audio.<ext>, not in the flat recordings folder', () => {
      const { sandbox, jobs, setName, createFile } = folderHarness()

      sandbox.doPost(
        dograhPost({
          capture_id: 'dograh-run-6',
          recording_url: 'https://dograh.example/audio/run-6.wav',
          call_time: '2026-08-26T18:04:00Z',
        }),
      )

      expect(setName).toHaveBeenCalledWith('audio.wav')
      expect(createFile).toHaveBeenCalledTimes(1)
      expect(sandbox.DriveApp.getFolderById).not.toHaveBeenCalled()
      expect(jobs.get('dograh-run-6')!.call_folder_id).toBe('call-folder-1')
    })

    it('writes the Dograh transcript and an opening manifest into the call folder', () => {
      const { sandbox, artifacts, manifests } = folderHarness()

      sandbox.doPost(
        dograhPost({
          capture_id: 'dograh-run-7',
          recording_url: 'https://dograh.example/audio/run-7.wav',
          transcript_url: 'https://dograh.example/transcript/run-7',
          call_time: '2026-08-26T18:04:00Z',
          duration_sec: 610,
        }),
      )

      expect(artifacts).toEqual([
        { name: 'transcript-dograh.txt', content: 'the roof is a six twelve' },
      ])
      expect(manifests[0]).toMatchObject({
        capture_id: 'dograh-run-7',
        source: 'dograh',
        duration_sec: 610,
        audio_drive_id: 'audio-file-1',
        runs: [],
      })
    })

    it('falls back to the flat recordings folder when no call folder can be made', () => {
      const { sandbox, jobs, setName } = folderHarness({ getOrCreateCallFolder: () => null })

      sandbox.doPost(
        dograhPost({
          capture_id: 'dograh-run-8',
          recording_url: 'https://dograh.example/audio/run-8.wav',
        }),
      )

      expect(setName).toHaveBeenCalledWith('dograh-run-8.wav')
      expect(sandbox.DriveApp.getFolderById).toHaveBeenCalled()
      expect(jobs.get('dograh-run-8')!.call_folder_id).toBe('')
    })

    it('still records the call when Drive throws on the folder', () => {
      const { sandbox, jobs, logged } = folderHarness({
        getOrCreateCallFolder: () => {
          throw new Error('Drive quota exceeded')
        },
      })

      sandbox.doPost(
        dograhPost({
          capture_id: 'dograh-run-9',
          recording_url: 'https://dograh.example/audio/run-9.wav',
        }),
      )

      expect(events(logged)).toContain('dograh.call_folder_failed')
      expect(jobs.get('dograh-run-9')!.status).toBe('pending')
      expect(jobs.get('dograh-run-9')!.audio_drive_id).toBe('flat-1')
    })

    it('still records the call when writing an artifact throws', () => {
      const { sandbox, jobs, logged } = folderHarness({
        writeCallArtifact: () => {
          throw new Error('Drive quota exceeded')
        },
      })

      sandbox.doPost(
        dograhPost({
          capture_id: 'dograh-run-10',
          recording_url: 'https://dograh.example/audio/run-10.wav',
          transcript_url: 'https://dograh.example/transcript/run-10',
        }),
      )

      expect(events(logged)).toContain('dograh.call_artifacts_failed')
      expect(jobs.get('dograh-run-10')!.status).toBe('pending')
    })
  })
})

describe('Manual recording inject', () => {
  function manualPost(body: Record<string, unknown>) {
    return {
      parameter: { t: SECRET, event: 'manual_recording_inject' },
      postData: { type: 'application/json', contents: JSON.stringify(body) },
    }
  }

  function manualHarness(overrides: Record<string, unknown> = {}) {
    return harness({
      loadEnums: () => ({}),
      validateLiveFields: () => ({}),
      ...overrides,
    })
  }

  it('denies a payload missing a transcript', () => {
    const { sandbox, jobs } = manualHarness()

    sandbox.doPost(manualPost({ capture_id: 'manual-1', audio_base64: 'YWJj' }))

    expect(jobs.has('manual-1')).toBe(false)
  })

  it('denies a payload missing audio', () => {
    const { sandbox, jobs } = manualHarness()

    sandbox.doPost(manualPost({ capture_id: 'manual-2', transcript: 'hello' }))

    expect(jobs.has('manual-2')).toBe(false)
  })

  it('denies a payload missing a capture_id', () => {
    const { sandbox, jobs } = manualHarness()

    sandbox.doPost(manualPost({ transcript: 'hello', audio_base64: 'YWJj' }))

    expect(jobs.size).toBe(0)
  })

  it('writes a pending dograh-sourced job from raw transcript text and base64 audio', () => {
    const { sandbox, jobs } = manualHarness()

    sandbox.doPost(
      manualPost({
        capture_id: 'manual-3',
        transcript: 'the roof is a six twelve',
        audio_base64: Buffer.from('fake-audio').toString('base64'),
        audio_extension: 'wav',
        call_time: '2026-08-26T18:04:00Z',
        duration_sec: 610,
        call_disposition: 'completed',
      }),
    )

    const job = jobs.get('manual-3')!
    expect(job).toMatchObject({
      source: 'dograh',
      status: 'pending',
      transcript: 'the roof is a six twelve',
      transcript_source: 'manual-test-inject',
      transcript_chars: 24,
      audio_drive_id: 'drive-1',
      call_started_at: '2026-08-26T18:04:00Z',
      duration_sec: 610,
      call_disposition: 'completed',
    })
  })

  it('puts the audio and transcript into the per-call folder when one is available', () => {
    const createFile = vi.fn(() => ({ getId: () => 'audio-file-1' }))
    const callFolder = { getId: () => 'call-folder-1', createFile }
    const newBlob = vi.fn((bytes: Buffer) => ({
      getDataAsString: () => Buffer.from(bytes).toString('utf-8'),
    }))
    const artifacts: Array<{ name: string; content: string }> = []

    const { sandbox, jobs } = manualHarness({
      getOrCreateCallFolder: vi.fn(() => callFolder),
      Utilities: { base64Decode: (value: string) => Buffer.from(value, 'base64'), newBlob },
      writeCallArtifact: (_folder: unknown, name: string, content: string) => {
        artifacts.push({ name, content })
        return 'artifact-' + name
      },
      writeManifest: () => 'manifest-1',
    })

    sandbox.doPost(
      manualPost({
        capture_id: 'manual-4',
        transcript: 'the roof is a six twelve',
        audio_base64: Buffer.from('fake-audio').toString('base64'),
      }),
    )

    expect(createFile).toHaveBeenCalledTimes(1)
    expect(newBlob).toHaveBeenCalledWith(expect.anything(), 'audio/wav', 'audio.wav')
    expect(artifacts).toEqual([
      { name: 'transcript-dograh.txt', content: 'the roof is a six twelve' },
    ])
    expect(jobs.get('manual-4')!.call_folder_id).toBe('call-folder-1')
  })
})

describe('Dograh Pre-Call Data Fetch', () => {
  function preCallPost(fromNumber = '+18176762145') {
    return {
      parameter: { t: SECRET, event: 'dograh_pre_call' },
      postData: {
        type: 'application/json',
        contents: JSON.stringify({
          event: 'call_inbound',
          call_inbound: { agent_id: 10849, from_number: fromNumber, to_number: '+18005550199' },
        }),
      },
    }
  }

  // handleDograhPreCall reads the real clock (new Date()), matching this
  // codebase's other "now"-dependent handlers — fixtures are offsets from the
  // actual test-run time rather than fixed dates, so this stays correct no
  // matter when the suite runs.
  function hoursAgoIso(hours: number) {
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  }

  function claim(overrides: Record<string, unknown> = {}) {
    return {
      claim_id: 'evt-1',
      insured_last_name: 'Love',
      address_line1: '1234 Happy Path Lane',
      city: 'Concord',
      claim_number: 'CLF-00153289',
      appt_start: hoursAgoIso(1),
      appt_end: hoursAgoIso(0.5),
      ...overrides,
    }
  }

  it('suggests the claim whose appointment most recently ended', () => {
    const { sandbox } = harness({
      getClaims: () => [
        claim({ claim_id: 'old', insured_last_name: 'Old', appt_end: hoursAgoIso(5) }),
        claim({ claim_id: 'recent', insured_last_name: 'Love', appt_end: hoursAgoIso(0.5) }),
      ],
    })

    const response = sandbox.doPost(preCallPost())
    const body = JSON.parse(response.body)

    expect(body.initial_context.has_claim_suggestion).toBe(true)
    expect(body.initial_context.suggested_insured_last_name).toBe('Love')
    expect(body.initial_context.suggested_address_line1).toBe('1234 Happy Path Lane')
  })

  it('reports no suggestion when nothing ended within the recency window', () => {
    const { sandbox } = harness({
      getClaims: () => [claim({ appt_end: hoursAgoIso(30) })],
    })

    const response = sandbox.doPost(preCallPost())
    const body = JSON.parse(response.body)

    expect(body.initial_context.has_claim_suggestion).toBe(false)
  })

  it('still returns has_claim_suggestion: false rather than failing the call when the claims lookup throws', () => {
    const { sandbox, logged } = harness({
      getClaims: () => {
        throw new Error('Missing column: appt_end')
      },
    })

    const response = sandbox.doPost(preCallPost())
    const body = JSON.parse(response.body)

    expect(body.initial_context.has_claim_suggestion).toBe(false)
    expect(events(logged)).toContain('dograh_pre_call.failed')
  })

  it('formats the candidate list for fallback matching, most recent first', () => {
    const { sandbox } = harness({
      getClaims: () => [
        claim({ claim_id: 'a', insured_last_name: 'Adams', appt_end: hoursAgoIso(5) }),
        claim({ claim_id: 'b', insured_last_name: 'Barnes', appt_end: hoursAgoIso(1) }),
      ],
    })

    const response = sandbox.doPost(preCallPost())
    const body = JSON.parse(response.body)
    const lines = body.initial_context.claims_candidates_text.split('\n')

    expect(lines[0]).toContain('Barnes')
    expect(lines[1]).toContain('Adams')
  })
})

describe('Retell ingest', () => {
  const CALL_ID = 'call_ef89bbc984713ff092a32719f09'

  function retellSignature(rawBody: string, timestamp: number) {
    const digest = crypto
      .createHmac('sha256', RETELL_API_KEY)
      .update(rawBody + timestamp)
      .digest('hex')
    return 'v=' + timestamp + ',d=' + digest
  }

  function retellPost(
    eventType: string,
    call: Record<string, unknown>,
    options: { sig?: string; timestamp?: number } = {},
  ) {
    const rawBody = JSON.stringify({ event: eventType, call })
    const timestamp = options.timestamp ?? Date.now()
    const sig = options.sig !== undefined ? options.sig : retellSignature(rawBody, timestamp)
    return {
      parameter: { t: SECRET, event: 'retell', retell_sig: sig },
      postData: { type: 'application/json', contents: rawBody },
    }
  }

  function retellHarness(overrides: Record<string, unknown> = {}) {
    return harness({
      loadEnums: () => ({}),
      validateLiveFields: () => ({}),
      ...overrides,
    })
  }

  function callEndedBody(overrides: Record<string, unknown> = {}) {
    return {
      call_id: CALL_ID,
      start_timestamp: 1788215566692,
      duration_ms: 118264,
      transcript: 'Agent: Hi. User: The roof is 3-tab.',
      transcript_object: [
        { role: 'agent', content: 'Hi.', words: [{ word: 'Hi.', start: 0, end: 0.5 }] },
      ],
      recording_url: 'https://retell.example/recording.wav',
      ...overrides,
    }
  }

  function callAnalyzedBody(overrides: Record<string, unknown> = {}) {
    return {
      call_id: CALL_ID,
      collected_dynamic_variables: { roof_covering_type: '3-tab' },
      call_analysis: { call_summary: 'Roof is 3-tab.', user_sentiment: 'Neutral' },
      ...overrides,
    }
  }

  describe('signature verification', () => {
    it('denies a request with no retell_sig at all', () => {
      const { sandbox, jobs, logged } = retellHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody(), { sig: '' }))

      expect(jobs.size).toBe(0)
      const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
      expect(terminal.event).toBe('webhook.denied')
      expect(terminal.reason).toBe('missing_retell_signature')
    })

    it('denies a malformed retell_sig that does not match v=...,d=...', () => {
      const { sandbox, jobs, logged } = retellHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody(), { sig: 'not-a-signature' }))

      expect(jobs.size).toBe(0)
      const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
      expect(terminal.reason).toBe('malformed_retell_signature')
    })

    it('denies a signature whose digest does not match the recomputed HMAC', () => {
      const { sandbox, jobs, logged } = retellHarness()

      sandbox.doPost(
        retellPost('call_ended', callEndedBody(), { sig: 'v=' + Date.now() + ',d=deadbeef' }),
      )

      expect(jobs.size).toBe(0)
      const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
      expect(terminal.reason).toBe('bad_retell_signature')
    })

    it('denies a signature whose timestamp is older than the 5 minute freshness window', () => {
      const { sandbox, jobs, logged } = retellHarness()
      const staleTimestamp = Date.now() - 6 * 60 * 1000

      sandbox.doPost(retellPost('call_ended', callEndedBody(), { timestamp: staleTimestamp }))

      expect(jobs.size).toBe(0)
      const terminal = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[1]
      expect(terminal.reason).toBe('stale_retell_signature')
    })

    it('accepts a correctly signed, fresh request', () => {
      const { sandbox, jobs } = retellHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody()))

      expect(jobs.has('retell-' + CALL_ID)).toBe(true)
    })
  })

  describe('namespacing', () => {
    it('keys the job as retell-<call_id>, distinct from a same-id dograh- row', () => {
      const { sandbox, jobs } = retellHarness()
      jobs.set('dograh-' + CALL_ID, { capture_id: 'dograh-' + CALL_ID, source: 'dograh' })

      sandbox.doPost(retellPost('call_ended', callEndedBody()))

      expect(jobs.has('retell-' + CALL_ID)).toBe(true)
      expect(jobs.get('dograh-' + CALL_ID)).toEqual({
        capture_id: 'dograh-' + CALL_ID,
        source: 'dograh',
      })
    })
  })

  describe('two-phase ingest ordering', () => {
    it('call_ended then call_analyzed: ends pending with transcript, audio, and live fields', () => {
      const { sandbox, jobs } = retellHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody()))
      sandbox.doPost(retellPost('call_analyzed', callAnalyzedBody()))

      const job = jobs.get('retell-' + CALL_ID)!
      expect(job.status).toBe('pending')
      expect(job.source).toBe('retell')
      expect(job.transcript).toBe('Agent: Hi. User: The roof is 3-tab.')
      expect(job.audio_drive_id).toBe('drive-1')
      expect(job.live_fields).toBe(JSON.stringify({ roof_covering_type: '3-tab' }))
      expect(job.call_analysis_data).toBe(
        JSON.stringify({ call_summary: 'Roof is 3-tab.', user_sentiment: 'Neutral' }),
      )
    })

    it('call_analyzed then call_ended (reverse order): same end state, no crash at either step', () => {
      const { sandbox, jobs } = retellHarness()

      expect(() => sandbox.doPost(retellPost('call_analyzed', callAnalyzedBody()))).not.toThrow()

      const midway = jobs.get('retell-' + CALL_ID)!
      expect(midway.status).toBe('awaiting_call_ended')
      expect(midway.call_analysis_data).toBe(
        JSON.stringify({ call_summary: 'Roof is 3-tab.', user_sentiment: 'Neutral' }),
      )

      expect(() => sandbox.doPost(retellPost('call_ended', callEndedBody()))).not.toThrow()

      const job = jobs.get('retell-' + CALL_ID)!
      expect(job.status).toBe('pending')
      expect(job.transcript).toBe('Agent: Hi. User: The roof is 3-tab.')
      expect(job.audio_drive_id).toBe('drive-1')
    })

    it('call_ended alone leaves the job awaiting_analysis', () => {
      const { sandbox, jobs } = retellHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody()))

      expect(jobs.get('retell-' + CALL_ID)!.status).toBe('awaiting_analysis')
    })
  })

  describe('call artifacts', () => {
    function folderHarness(overrides: Record<string, unknown> = {}) {
      const artifacts: Array<{ name: string; content: string }> = []
      const createFile = vi.fn(() => ({ getId: () => 'audio-file-1' }))
      const callFolder = { getId: () => 'call-folder-1', createFile }

      const built = retellHarness({
        getOrCreateCallFolder: vi.fn(() => callFolder),
        writeCallArtifact: (_folder: unknown, name: string, content: string) => {
          artifacts.push({ name, content })
          return 'artifact-' + name
        },
        UrlFetchApp: {
          fetch: () => ({
            getResponseCode: () => 200,
            getBlob: () => ({ setName: () => 'blob' }),
          }),
        },
        ...overrides,
      })

      return { ...built, artifacts }
    }

    it('writes the inline transcript and per-word transcript_object into the call folder', () => {
      const { sandbox, artifacts } = folderHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody()))

      expect(artifacts).toContainEqual({
        name: 'transcript-retell.txt',
        content: 'Agent: Hi. User: The roof is 3-tab.',
      })
      const wordsArtifact = artifacts.find((a) => a.name === 'transcript-retell-words.json')
      expect(wordsArtifact).toBeDefined()
      expect(JSON.parse(wordsArtifact!.content)).toEqual(callEndedBody().transcript_object)
    })

    it('does not write transcript-retell-words.json when transcript_object is absent', () => {
      const { sandbox, artifacts } = folderHarness()

      sandbox.doPost(retellPost('call_ended', callEndedBody({ transcript_object: undefined })))

      expect(artifacts.some((a) => a.name === 'transcript-retell-words.json')).toBe(false)
    })
  })

  it('denies (but 200s) an unhandled Retell lifecycle event like call_started', () => {
    const { sandbox, jobs, logged } = retellHarness()

    const response = sandbox.doPost(retellPost('call_started', { call_id: CALL_ID }))

    expect(response.body).toBe('OK')
    expect(jobs.size).toBe(0)
    const lines = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    expect(lines[lines.length - 1].reason).toBe('retell_unhandled_event')
  })

  it('denies a payload missing call.call_id', () => {
    const { sandbox, jobs } = retellHarness()

    sandbox.doPost(retellPost('call_ended', { call_id: '' }))

    expect(jobs.size).toBe(0)
  })
})

describe('doGet', () => {
  it('answers a reachability probe and logs it', () => {
    const { sandbox, logged } = harness()

    const response = sandbox.doGet({ parameter: {} })

    expect(response.body).toBe('adjuster-webhook ok')
    expect(events(logged)).toEqual(['webhook.ping'])
    expect(logged[0]).toContain('"response_body":"adjuster-webhook ok"')
  })
})
