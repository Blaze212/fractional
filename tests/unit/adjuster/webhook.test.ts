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
        MimeType: { XML: 'XML', JSON: 'JSON' },
        createTextOutput: (body: string) => ({ body, setMimeType: () => ({ body }) }),
      },
      getClaims: () => [],
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
      validateDograhFields: () => ({}),
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

describe('doGet', () => {
  it('answers a reachability probe and logs it', () => {
    const { sandbox, logged } = harness()

    const response = sandbox.doGet({ parameter: {} })

    expect(response.body).toBe('adjuster-webhook ok')
    expect(events(logged)).toEqual(['webhook.ping'])
    expect(logged[0]).toContain('"response_body":"adjuster-webhook ok"')
  })
})
