import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const SECRET = 'shared-secret'
const CAPTURE = '410b941e-9c3a-11f1-9361-52d0a1d78284'
const BASE_URL = 'https://script.google.com/macros/s/ABC123/exec'

type Job = Record<string, unknown>

function harness(overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>()
  const logged: string[] = []

  const sandbox = loadGs(
    ['apps/adjuster/src/log.js', 'apps/adjuster/src/webhook.js', 'apps/adjuster/src/guidedFlow.js'],
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
      withJobLock: (fn: () => unknown) => fn(),
      ContentService: {
        MimeType: { XML: 'XML' },
        createTextOutput: (body: string) => ({ body, setMimeType: () => ({ body }) }),
      },
      ScriptApp: { getService: () => ({ getUrl: () => BASE_URL }) },
      Utilities: {
        base64Decode: (value: string) => Buffer.from(value, 'base64'),
        newBlob: (bytes: Buffer) => ({
          getDataAsString: () => Buffer.from(bytes).toString('utf-8'),
        }),
      },
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200 }) },
      DriveApp: {},
      ...overrides,
    },
  )

  return { sandbox, jobs, logged }
}

function post(params: Record<string, string>) {
  return { parameter: { t: SECRET, CallSessionId: CAPTURE, From: '+18176762145', ...params } }
}

describe('guided flow — TeXML shape', () => {
  it('starts with the first section as a Record turn with no filler', () => {
    const { sandbox } = harness()

    const response = sandbox.doPost(post({ event: 'guided_start' }))

    expect(response.body).toContain('<Record')
    expect(response.body).toContain(sandbox.GUIDED_SECTIONS[0].say)
    expect(response.body).not.toMatch(/press \d/i)
    expect(response.body).not.toMatch(/say yes or no/i)
  })

  it('builds a Gather turn without announcing DTMF options', () => {
    const { sandbox } = harness()

    const xml = sandbox.buildGatherTeXML(sandbox.GUIDED_SECTIONS_BY_ID.roof_status)

    expect(xml).toContain('<Gather')
    expect(xml).toContain('input="dtmf speech"')
    expect(xml).toContain('Roof — affected or not?')
    expect(xml).not.toMatch(/press \d/i)
  })

  it('builds an AIGather turn with the section schema in a CDATA block', () => {
    const { sandbox } = harness()

    const xml = sandbox.buildAIGatherTeXML(sandbox.GUIDED_SECTIONS_BY_ID.mortgage)

    expect(xml).toContain('<AIGather')
    expect(xml).toContain('<Greeting>Does the insured have a mortgage on the property?</Greeting>')
    expect(xml).toContain('<![CDATA[')
    const schema = JSON.parse(xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)![1])
    expect(schema.required).toEqual(['mortgage_status'])
    expect(schema.properties.mortgage_status.enum).toEqual(['has_mortgage', 'no_mortgage'])
  })

  it('action URLs carry the step id and never expose the shared secret in plain digits-only form', () => {
    const { sandbox } = harness()

    const xml = sandbox.buildRecordTeXML(sandbox.GUIDED_SECTIONS_BY_ID.origin)

    expect(xml).toContain('event=guided&amp;step=origin')
    expect(xml).toContain('t=' + SECRET)
    expect(xml).toContain('transcriptionCallback')
    expect(xml).toContain('recordingStatusCallback')
  })
})

describe('guided flow — Gather branch resolution (roof_status)', () => {
  it.each([
    ['not affected', 'not_affected', 'exterior'],
    ['yeah, shingle roof got hit', 'shingle', 'roof_shingle'],
    ['it has a metal roof', 'other_material', 'roof_other'],
  ])('resolves "%s" to %s and advances to %s', (speech, expectedValue, expectedNextStep) => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))

    const response = sandbox.doPost(
      post({ event: 'guided', step: 'roof_status', SpeechResult: speech }),
    )

    const state = JSON.parse((jobs.get(CAPTURE) as Job).guided_state as string)
    expect(state.captured.roof_status).toBe(expectedValue)
    expect(state.currentStep).toBe(expectedNextStep)
    expect(response.body).toContain(sandbox.GUIDED_SECTIONS_BY_ID[expectedNextStep].say)
  })

  it('resolves a DTMF press without ever having announced the digit menu', () => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))

    sandbox.doPost(post({ event: 'guided', step: 'roof_status', Digits: '2' }))

    const state = JSON.parse((jobs.get(CAPTURE) as Job).guided_state as string)
    expect(state.captured.roof_status).toBe('shingle')
  })

  it('logs an ambiguity event and still picks a branch when the answer is unclear', () => {
    const { sandbox, logged } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))

    sandbox.doPost(post({ event: 'guided', step: 'roof_status', SpeechResult: 'uh, kind of' }))

    const events = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
    expect(events).toContain('guided.branch_ambiguous')
  })
})

describe('guided flow — AIGather result capture', () => {
  it('merges parsed JSON fields into captured state and drops unknown keys', () => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))
    sandbox.doPost(post({ event: 'guided', step: 'contact_info' }))
    sandbox.doPost(post({ event: 'guided', step: 'claim_info' }))

    sandbox.doPost(
      post({
        event: 'guided',
        step: 'assignment',
        Result: JSON.stringify({
          contacted_party_name: 'Barton, the insured',
          present_at_inspection: 'Barton and the adjuster',
          unrelated_field: 'should be dropped',
        }),
      }),
    )

    const state = JSON.parse((jobs.get(CAPTURE) as Job).guided_state as string)
    expect(state.captured.contacted_party_name).toBe('Barton, the insured')
    expect(state.captured.present_at_inspection).toBe('Barton and the adjuster')
    expect(state.captured.unrelated_field).toBeUndefined()
    expect(state.currentStep).toBe('mortgage')
  })

  it('logs when no known AIGather result parameter is present', () => {
    const { sandbox, logged } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))
    sandbox.doPost(post({ event: 'guided', step: 'contact_info' }))
    sandbox.doPost(post({ event: 'guided', step: 'claim_info' }))

    sandbox.doPost(post({ event: 'guided', step: 'assignment' }))

    const events = logged.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event)
    expect(events).toContain('guided.aigather_unparsed')
  })
})

describe('guided flow — Record sections and async transcription', () => {
  it('advances immediately on the Record action without waiting for the transcript', () => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))

    const response = sandbox.doPost(
      post({ event: 'guided', step: 'contact_info', RecordingUrl: 'https://s3/contact.mp3' }),
    )

    expect(response.body).toContain(sandbox.GUIDED_SECTIONS_BY_ID.claim_info.say)
    const state = JSON.parse((jobs.get(CAPTURE) as Job).guided_state as string)
    expect(state.currentStep).toBe('claim_info')
    expect((jobs.get(CAPTURE) as Job).status).toBe('guided_in_progress')
  })

  it('attaches a late transcript to the right section even after later sections complete', () => {
    const { sandbox, jobs } = harness()
    sandbox.doPost(post({ event: 'guided_start' }))
    sandbox.doPost(post({ event: 'guided', step: 'contact_info' }))

    // transcription for contact_info lands only after claim_info's own action fires
    sandbox.doPost(post({ event: 'guided', step: 'claim_info' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'contact_info',
        TranscriptionText: 'Barton Holdridge, 10503 Waters Drive',
      }),
    )

    const state = JSON.parse((jobs.get(CAPTURE) as Job).guided_state as string)
    const entry = state.sectionTranscripts.find((e: { step: string }) => e.step === 'contact_info')
    expect(entry.transcript).toBe('Barton Holdridge, 10503 Waters Drive')
  })
})

describe('guided flow — end-to-end happy path', () => {
  it('walks every section and stitches a labeled transcript compatible with the existing pipeline', () => {
    const { sandbox, jobs } = harness()

    sandbox.doPost(post({ event: 'guided_start' }))
    sandbox.doPost(post({ event: 'guided', step: 'contact_info' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'contact_info',
        TranscriptionText: 'Barton Holdridge, 10503 Waters Drive, Irving',
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'claim_info' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'claim_info',
        TranscriptionText: 'CLM112233, State Farm',
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'assignment',
        Result: JSON.stringify({
          contacted_party_name: 'Barton, the insured',
          present_at_inspection: 'Barton and the adjuster',
        }),
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'mortgage',
        Result: JSON.stringify({ mortgage_status: 'no_mortgage' }),
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'origin' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'origin',
        TranscriptionText: 'Electrical fire started at an outlet in the garage',
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'coverage',
        Result: JSON.stringify({
          coverage_cause_narrative: 'electrical fire, covered peril',
          coverage_determination: 'covered',
        }),
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'risk_information',
        Result: JSON.stringify({
          dwelling_stories: '1 story',
          dwelling_type: 'single family',
          foundation_type: 'slab',
          square_footage: '2150',
          bedroom_count: 4,
          bathroom_count: 2,
          occupancy_status: 'the insured',
        }),
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'risk_siding_year',
        Result: JSON.stringify({ siding_type: 'a brick veneer' }),
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'roof_status', SpeechResult: 'not affected' }))
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'exterior',
        Result: JSON.stringify({ exterior_status: 'not_affected' }),
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'interior' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'interior',
        TranscriptionText: 'Smoke through the hallway',
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'personal_property',
        Result: JSON.stringify({ personal_property_status: 'none' }),
      }),
    )
    sandbox.doPost(
      post({
        event: 'guided',
        step: 'mitigation',
        Result: JSON.stringify({ mitigation_status: 'none' }),
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'overhead_profit' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'overhead_profit',
        TranscriptionText: 'Standard O&P applies',
      }),
    )
    sandbox.doPost(post({ event: 'guided', step: 'subrogation' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'subrogation',
        TranscriptionText: 'No subrogation, weather related',
      }),
    )
    const final = sandbox.doPost(post({ event: 'guided', step: 'coinsurance' }))
    sandbox.doPost(
      post({
        event: 'guided_transcription',
        step: 'coinsurance',
        TranscriptionText: 'Not applicable',
      }),
    )

    expect(final.body).toContain('Hang up whenever')

    const job = jobs.get(CAPTURE) as Job
    expect(job.status).toBe('pending')
    expect(job.transcript_source).toBe('telnyx-deepgram-nova-3-guided')

    const transcript = job.transcript as string
    expect(transcript).toContain('[CONTACT_INFO]')
    expect(transcript).toContain('Barton Holdridge, 10503 Waters Drive, Irving')
    expect(transcript).toContain('[MORTGAGE]')
    expect(transcript).toContain('mortgage_status: no_mortgage')
    expect(transcript).toContain('[COVERAGE]')
    expect(transcript).toContain('coverage_determination: covered')
    expect(transcript).toContain('[ROOF_STATUS]')
    expect(transcript).toContain('roof_status: not_affected')
    expect(transcript).toContain('[COINSURANCE]')
    expect(transcript).toContain('Not applicable')
  })
})
