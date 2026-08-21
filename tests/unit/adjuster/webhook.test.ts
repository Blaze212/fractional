import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

const SECRET = 'shared-secret'
const CAPTURE = '410b941e-9c3a-11f1-9361-52d0a1d78284'

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
        MimeType: { XML: 'XML' },
        createTextOutput: (body: string) => ({ body, setMimeType: () => ({ body }) }),
      },
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName: () => 'blob' }) }),
      },
      DriveApp: { getFolderById: () => ({ createFile: () => ({ getId: () => 'drive-1' }) }) },
      Utilities: {
        base64Decode: (value: string) => Buffer.from(value, 'base64'),
        newBlob: (bytes: Buffer) => ({
          getDataAsString: () => Buffer.from(bytes).toString('utf-8'),
        }),
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

describe('doGet', () => {
  it('answers a reachability probe and logs it', () => {
    const { sandbox, logged } = harness()

    const response = sandbox.doGet({ parameter: {} })

    expect(response.body).toBe('adjuster-webhook ok')
    expect(events(logged)).toEqual(['webhook.ping'])
  })
})
