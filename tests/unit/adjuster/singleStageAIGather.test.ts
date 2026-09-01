import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const SECRET = 'shared-secret'
const CAPTURE = '410b941e-9c3a-11f1-9361-52d0a1d78284'

type Job = Record<string, unknown>

function harness(overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>()
  const logged: string[] = []
  const lock = { held: 0, maxHeld: 0 }

  const sandbox = loadGs(
    [
      'apps/adjuster/src/log.js',
      'apps/adjuster/src/util.js',
      'apps/adjuster/src/webhook.js',
      'apps/adjuster/src/guidedFlow.js',
    ],
    {
      console: {
        log: (line: string) => logged.push(line),
        error: (line: string) => logged.push(line),
      },
      getConfig: (key: string) => {
        if (key === 'WEBHOOK_SECRET') return SECRET
        throw new Error('Missing script property: ' + key)
      },
      getConfigList: () => ['+18176762145'],
      appendRaw: () => {},
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
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200 }) },
      DriveApp: {},
      ...overrides,
    },
  )

  return { sandbox, jobs, logged, lock }
}

function post(params: Record<string, string>) {
  return { parameter: { t: SECRET, CallSessionId: CAPTURE, ...params } }
}

const MESSAGES = JSON.stringify([
  { role: 'assistant', content: "Who's the insured?", timestamp: '1' },
  { role: 'user', content: 'Barton Holdridge, 10503 Waters Drive', timestamp: '2' },
])

function aiGatherEnded(overrides: Record<string, string> = {}) {
  return post({
    ConversationId: 'conv-1',
    Messages: MESSAGES,
    DurationSec: '340',
    CallStatus: 'conversation_ended',
    Reason: 'normal',
    ...overrides,
  })
}

describe('single-stage AIGather — a fresh call session with no guided_state', () => {
  it('finalizes the job as pending with a stitched Q/A transcript', () => {
    const { sandbox, jobs } = harness()

    const response = sandbox.doPost(aiGatherEnded())

    expect(response.body).toBe('OK')
    const job = jobs.get(CAPTURE)!
    expect(job.transcript).toBe(
      "[AIGATHER CONVERSATION]\nQ: Who's the insured?\nA: Barton Holdridge, 10503 Waters Drive",
    )
    expect(job.transcript_source).toBe('telnyx-aigather-single-stage')
    expect(job.transcript_chars).toBe((job.transcript as string).length)
    expect(job.status).toBe('pending')
    expect(job.duration_sec).toBe(340)
  })

  it('takes the job lock exactly once', () => {
    const { sandbox, lock } = harness()

    sandbox.doPost(aiGatherEnded())

    expect(lock.maxHeld).toBe(1)
    expect(lock.held).toBe(0)
  })

  it('logs the received/accepted pair, not a guided-flow event', () => {
    const { sandbox, logged } = harness()

    sandbox.doPost(aiGatherEnded())

    const events = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
    expect(events).toEqual(['webhook.received', 'webhook.accepted'])
  })

  it('logs a no_transcript event and still finalizes the job when Messages is empty', () => {
    const { sandbox, jobs, logged } = harness()

    sandbox.doPost(aiGatherEnded({ Messages: '[]' }))

    const job = jobs.get(CAPTURE)!
    expect(job.transcript).toBe('[AIGATHER CONVERSATION]\n')
    expect(job.status).toBe('pending')
    const events = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
    expect(events).toContain('single_aigather.no_transcript')
  })
})

function callAnalyzed(overrides: Record<string, string> = {}) {
  return post({
    ConversationId: 'conv-1',
    Recordings: '[]',
    Cost: '{"total":"0.33"}',
    ConversationInsights: '[]',
    ...overrides,
  })
}

describe('single-stage AIGather — call.ai_gather.ended vs analyzed shape routing', () => {
  it('does not mistake an analyzed event for an AIGather-ended one, or vice versa', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(callAnalyzed({ Recordings: '["https://s3/rec.mp3"]' }))
    sandbox.doPost(aiGatherEnded())

    const job = jobs.get(CAPTURE)!
    expect(job.recording_url).toBe('https://s3/rec.mp3')
    expect(job.transcript).toContain('[AIGATHER CONVERSATION]')
    expect(job.transcript_source).toBe('telnyx-aigather-single-stage')
  })
})

describe('single-stage AIGather — the analyzed event (recording)', () => {
  it('extracts a bare URL string from Recordings and merges it into the transcript', () => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(aiGatherEnded())

    sandbox.doPost(callAnalyzed({ Recordings: '["https://s3/rec.mp3"]' }))

    const job = jobs.get(CAPTURE)!
    expect(job.recording_url).toBe('https://s3/rec.mp3')
    expect(job.transcript).toBe(
      "[AIGATHER CONVERSATION]\nQ: Who's the insured?\nA: Barton Holdridge, 10503 Waters Drive\n\n[CALL RECORDING]\nhttps://s3/rec.mp3",
    )
  })

  it('extracts a url from an object-shaped Recordings entry', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(callAnalyzed({ Recordings: '[{"recording_url":"https://s3/rec2.mp3"}]' }))

    expect(jobs.get(CAPTURE)!.recording_url).toBe('https://s3/rec2.mp3')
  })

  it('merges correctly when analyzed arrives before call.ai_gather.ended', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(callAnalyzed({ Recordings: '["https://s3/rec.mp3"]' }))
    sandbox.doPost(aiGatherEnded())

    const job = jobs.get(CAPTURE)!
    expect(job.transcript).toBe(
      "[CALL RECORDING]\nhttps://s3/rec.mp3\n\n[AIGATHER CONVERSATION]\nQ: Who's the insured?\nA: Barton Holdridge, 10503 Waters Drive",
    )
  })

  it('logs and takes no action when Recordings is empty, without creating a job', () => {
    const { sandbox, jobs, logged } = harness()

    sandbox.doPost(callAnalyzed())

    expect(jobs.has(CAPTURE)).toBe(false)
    const events = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
    expect(events).toContain('call_analyzed.no_recording')
  })

  it('logs the full raw payload via logServerOnly for shape discovery', () => {
    const { sandbox, logged } = harness()

    sandbox.doPost(callAnalyzed({ Recordings: '["https://s3/rec.mp3"]' }))

    const raw = logged.map((l) => JSON.parse(l)).find((l) => l.event === 'call_analyzed.raw')
    expect(raw.recordings).toBe('["https://s3/rec.mp3"]')
  })
})

describe('single-stage AIGather — routing does not collide with the guided flow', () => {
  it('routes call.ai_gather.ended to the guided handler when the job is mid guided flow', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(post({ event: 'guided_start', From: '+18176762145' }))
    // guided_start's first section is contact_info (a Record), so its
    // guided_state.currentStep is not an aigather section — the guided
    // handler should hang up rather than mistake this for a single-stage
    // call's completion.
    const response = sandbox.doPost(aiGatherEnded())

    expect(response.body).toContain('<Hangup/>')
    const state = JSON.parse(jobs.get(CAPTURE)!.guided_state as string)
    expect(state.flow).toBe('guided')
  })
})
