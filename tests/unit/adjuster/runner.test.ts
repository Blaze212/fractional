import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

type Job = Record<string, any>

const TAG_SCHEMA = {
  contacted_party_name: { label: 'Contacted party', type: 'string', required: true },
}

function harness(jobRows: Job[], overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>()
  jobRows.forEach((job) => jobs.set(job.capture_id, { ...job }))

  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const leases: Array<{ capture_id: string; fields: Record<string, unknown> }> = []
  const extractCalls: Record<string, any>[] = []
  const validateCalls: Array<{ transcript: string }> = []
  const transcriptionCalls: Array<{ job: Job; claim: Job | null }> = []
  const artifactWrites: Array<{ job: Job; extraction: Record<string, any> }> = []

  const sandbox = loadGs('apps/adjuster/src/runner.js', {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    describeError: (err: Error) => ({ error: String(err.message ?? err), stack: 'stack' }),
    getConfig: () => 'x',
    getOptionalConfig: (_key: string, fallback: string) => fallback,
    getConfigList: () => [],
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {} },

    reclaimStuckJobs: () => {},
    ensureJobsColumns: () => [],
    JOBS_TRANSCRIPTION_COLUMNS: ['call_folder_id'],

    getOldestJobByStatus: (status: string) => {
      const matching = [...jobs.values()]
        .filter((job) => job.status === status)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      return { sheet: 'sheet', headers: ['capture_id'], job: matching[0] ?? null }
    },
    getOldestPendingJob: () => sandbox.getOldestJobByStatus('pending'),
    getJobByCaptureId: (id: string) => jobs.get(id) ?? null,
    upsertJob: (id: string, fields: Job) => {
      jobs.set(id, { ...(jobs.get(id) ?? {}), ...fields })
    },
    writeRowFields: (_sheet: unknown, _headers: unknown, _rowIndex: number, fields: Job) => {
      // Only the lease path reaches here; the leased job is whichever one the
      // dispatcher just picked, so record it against every pending/transcribed
      // candidate rather than resolving a row index the fake sheet has no idea
      // about.
      leases.push({ capture_id: '', fields })
    },

    getClaims: () => [{ claim_id: 'claim-1', insured_last_name: 'Henderson' }],
    // Identity by default — see docs/specs/022. Tests that care whether
    // resolveClaimMatch() actually threads the projection through override
    // this to a marker function instead of asserting against job.transcript.
    adjusterTurnsOf: (transcript: string) => transcript,
    detectLabelVocabulary: () => '',
    matchClaim: () => ({ claim_id: 'claim-1', match_method: 'exact', match_confidence: 'high' }),
    matchClaimWithLlm: () => ({ claim_id: '', match_method: 'none', match_confidence: 'low' }),
    loadEnums: () => TAG_SCHEMA,
    loadGlossary: () => [],
    loadPhraseBank: () => [],

    runTranscriptionPass: vi.fn((job: Job, claim: Job | null) => {
      transcriptionCalls.push({ job, claim })
      return { extraction_input: 'dograh' }
    }),
    resolveExtractionTranscript: (job: Job) => ({
      source: job.extraction_input || 'dograh',
      transcript: job.extraction_input === 'master' ? 'master text' : String(job.transcript ?? ''),
      haystack:
        job.extraction_input === 'master' ? 'master haystack' : String(job.transcript ?? ''),
    }),

    extractFields: vi.fn((input: Record<string, any>) => {
      extractCalls.push(input)
      return { fields: {}, unplaced_notes: [], model: 'test-model' }
    }),
    validateFields: (_fields: unknown, transcript: string) => {
      validateCalls.push({ transcript })
      return { contacted_party_name: { valid: true } }
    },
    applyCalendarFallback: (validated: unknown) => validated,
    applyClaimPropertyFallback: (validated: unknown) => validated,
    dropCoverageRestatement: (validated: unknown) => ({ validated, dropped: null }),
    collectOffSuggestionFields: () => [],
    generateDoc: () => ({ status: 'done', docUrl: 'https://doc', needsInputCount: 0 }),
    notifyJobFailed: () => {},
    // Defined in replay.js, which this sandbox does not load. Stubbed rather
    // than ignored: the pipeline persisting extraction.json is what makes a
    // later free replay possible, so it is asserted below.
    writeExtractionArtifact: (job: Job, _claim: Job | null, _input: unknown, extraction: any) => {
      artifactWrites.push({ job, extraction })
      return 'artifact-id'
    },
    ...overrides,
  })

  return {
    sandbox,
    jobs,
    logged,
    leases,
    extractCalls,
    validateCalls,
    transcriptionCalls,
    artifactWrites,
  }
}

function dograhJob(overrides: Job = {}): Job {
  return {
    capture_id: 'dograh-1',
    created_at: '2026-08-26T18:00:00Z',
    source: 'dograh',
    status: 'pending',
    transcript: 'dograh text',
    audio_drive_id: 'audio-1',
    live_fields: '{}',
    _rowIndex: 2,
    ...overrides,
  }
}

function events(logged: Array<{ event: string }>) {
  return logged.map((l) => l.event)
}

describe('processOldestPendingJob dispatch', () => {
  it('runs stage A on a pending job and stops at transcribed', () => {
    const { sandbox, jobs, transcriptionCalls } = harness([dograhJob()])

    sandbox.processOldestPendingJob()

    expect(transcriptionCalls).toHaveLength(1)
    expect(jobs.get('dograh-1')?.status).toBe('transcribed')
    expect(jobs.get('dograh-1')?.claim_id).toBe('claim-1')
  })

  it('runs stage B on a transcribed job and finishes at done', () => {
    const { sandbox, jobs, transcriptionCalls } = harness([
      dograhJob({ status: 'transcribed', claim_id: 'claim-1' }),
    ])

    sandbox.processOldestPendingJob()

    expect(transcriptionCalls).toHaveLength(0)
    expect(jobs.get('dograh-1')?.status).toBe('done')
    expect(jobs.get('dograh-1')?.doc_url).toBe('https://doc')
  })

  it('drains work already in flight before starting anything new', () => {
    const { sandbox, jobs } = harness([
      dograhJob({ capture_id: 'older-pending', created_at: '2026-08-26T17:00:00Z' }),
      dograhJob({
        capture_id: 'newer-transcribed',
        created_at: '2026-08-26T19:00:00Z',
        status: 'transcribed',
      }),
    ])

    sandbox.processOldestPendingJob()

    expect(jobs.get('newer-transcribed')?.status).toBe('done')
    expect(jobs.get('older-pending')?.status).toBe('pending')
  })

  it('advances one job by one stage per tick', () => {
    const { sandbox, jobs } = harness([dograhJob()])

    sandbox.processOldestPendingJob()
    expect(jobs.get('dograh-1')?.status).toBe('transcribed')

    sandbox.processOldestPendingJob()
    expect(jobs.get('dograh-1')?.status).toBe('done')
  })

  it('says so and does nothing when neither queue has work', () => {
    const { sandbox, logged } = harness([dograhJob({ status: 'done' })])

    sandbox.processOldestPendingJob()

    expect(events(logged)).toEqual(['runner.no_pending_jobs'])
  })

  it('leases stage A as matching and stage B as extracting', () => {
    const { sandbox, leases } = harness([dograhJob()])

    sandbox.processOldestPendingJob()
    expect(leases[0].fields.status).toBe('matching')

    sandbox.processOldestPendingJob()
    expect(leases[1].fields.status).toBe('extracting')
  })

  it('resets attempts on a clean stage handoff so stage B gets its own budget', () => {
    const { sandbox, jobs } = harness([dograhJob({ attempts: 2 })])

    sandbox.processOldestPendingJob()

    expect(jobs.get('dograh-1')?.attempts).toBe(0)
  })

  it('fails the job with its stage recorded when a stage throws', () => {
    const { sandbox, jobs, logged } = harness([dograhJob()], {
      runTranscriptionPass: () => {
        throw new Error('elevenlabs exploded')
      },
    })

    sandbox.processOldestPendingJob()

    const threw = logged.find((l) => l.event === 'runner.job_threw')
    expect(threw?.fields.stage).toBe('transcribe')
    expect(jobs.get('dograh-1')?.status).toBe('pending')
    expect(jobs.get('dograh-1')?.error).toBe('elevenlabs exploded')
  })

  it('gives up after three attempts rather than retrying forever', () => {
    const { sandbox, jobs } = harness([dograhJob({ attempts: 3 })], {
      runTranscriptionPass: () => {
        throw new Error('still broken')
      },
    })

    sandbox.processOldestPendingJob()

    expect(jobs.get('dograh-1')?.status).toBe('failed')
  })
})

describe('stage A', () => {
  it('hands the matched claim to the transcription pass, since it feeds the keyterms', () => {
    const { sandbox, transcriptionCalls } = harness([dograhJob()])

    sandbox.processOldestPendingJob()

    expect(transcriptionCalls[0].claim).toEqual({
      claim_id: 'claim-1',
      insured_last_name: 'Henderson',
    })
  })

  it('matches against the adjuster-only projection, never the raw transcript (spec 022)', () => {
    const matchClaimCalls: unknown[] = []
    const matchClaimWithLlmCalls: unknown[] = []
    const { sandbox } = harness([dograhJob({ transcript: 'Agent: guess\nUser: real answer' })], {
      adjusterTurnsOf: (transcript: string) => 'PROJECTED(' + transcript + ')',
      detectLabelVocabulary: () => 'retell',
      matchClaim: (_startedAt: string, transcript: string) => {
        matchClaimCalls.push(transcript)
        return { claim_id: '', match_method: 'none', match_confidence: 'none' }
      },
      matchClaimWithLlm: (_startedAt: string, transcript: string) => {
        matchClaimWithLlmCalls.push(transcript)
        return { claim_id: '', match_method: 'none', match_confidence: 'none' }
      },
    })

    sandbox.processOldestPendingJob()

    expect(matchClaimCalls).toEqual(['PROJECTED(Agent: guess\nUser: real answer)'])
    expect(matchClaimWithLlmCalls).toEqual(['PROJECTED(Agent: guess\nUser: real answer)'])
  })

  it('logs the match input with the detected vocabulary and both char counts', () => {
    const { sandbox, logged } = harness(
      [dograhJob({ transcript: 'Agent: hi\nUser: hello there' })],
      {
        adjusterTurnsOf: () => 'hello there',
        detectLabelVocabulary: () => 'retell',
      },
    )

    sandbox.processOldestPendingJob()

    const matchInput = logged.find((l) => l.event === 'runner.match_input')
    expect(matchInput?.fields).toEqual({
      capture_id: 'dograh-1',
      label_vocabulary: 'retell',
      full_chars: 'Agent: hi\nUser: hello there'.length,
      adjuster_chars: 'hello there'.length,
    })
  })

  // docs/specs/022 phase 3 — a deterministic win resting on address alone is
  // exactly the shape a rejected read-back suggestion produces, so it goes to
  // the LLM for a second opinion even though matchClaim() was confident enough
  // to return a method other than 'none'/'ambiguous'.
  describe('address-only deterministic wins go to adjudication', () => {
    it('sends an address-only win to the LLM and logs why', () => {
      const { sandbox, logged, jobs } = harness([dograhJob()], {
        matchClaim: () => ({
          claim_id: 'claim-1',
          match_method: 'identity',
          match_confidence: 'low',
          candidates: [
            {
              claim_id: 'claim-1',
              score: 60,
              signals: { street_number: true, street_name: true, city: true },
            },
          ],
        }),
        matchClaimWithLlm: () => ({
          claim_id: 'claim-1',
          match_method: 'llm',
          match_confidence: 'high',
        }),
      })

      sandbox.processOldestPendingJob()

      const attempted = logged.find((l) => l.event === 'runner.llm_match_attempted')
      expect(attempted?.fields.trigger_reason).toBe('address_only')
      expect(jobs.get('dograh-1')?.match_method).toBe('llm')
    })

    it('leaves an address-only win in place when the LLM has nothing to add (c2 survives adjudication)', () => {
      const { sandbox, jobs } = harness([dograhJob()], {
        matchClaim: () => ({
          claim_id: 'claim-1',
          match_method: 'identity',
          match_confidence: 'low',
          candidates: [
            {
              claim_id: 'claim-1',
              score: 60,
              signals: { street_number: true, street_name: true, city: true },
            },
          ],
        }),
        matchClaimWithLlm: () => ({ claim_id: '', match_method: 'none', match_confidence: 'none' }),
      })

      sandbox.processOldestPendingJob()

      expect(jobs.get('dograh-1')?.match_method).toBe('identity')
      expect(jobs.get('dograh-1')?.claim_id).toBe('claim-1')
    })

    it('does not send a claim-number win to the LLM', () => {
      const { sandbox, logged } = harness([dograhJob()], {
        matchClaim: () => ({
          claim_id: 'claim-1',
          match_method: 'claim-number',
          match_confidence: 'high',
          candidates: [{ claim_id: 'claim-1', score: 100, signals: { claim_number: true } }],
        }),
      })

      sandbox.processOldestPendingJob()

      expect(logged.find((l) => l.event === 'runner.llm_match_attempted')).toBeUndefined()
    })

    it('does not send an insured-name-based win to the LLM', () => {
      const { sandbox, logged } = harness([dograhJob()], {
        matchClaim: () => ({
          claim_id: 'claim-1',
          match_method: 'identity',
          match_confidence: 'high',
          candidates: [
            {
              claim_id: 'claim-1',
              score: 75,
              signals: { insured_last_name: true, street_name: true, city: true },
            },
          ],
        }),
      })

      sandbox.processOldestPendingJob()

      expect(logged.find((l) => l.event === 'runner.llm_match_attempted')).toBeUndefined()
    })
  })

  it('falls back to the LLM matcher when deterministic matching cannot confirm a claim', () => {
    const { sandbox, jobs, logged } = harness([dograhJob()], {
      matchClaim: () => ({ claim_id: '', match_method: 'none', match_confidence: 'low' }),
      matchClaimWithLlm: () => ({
        claim_id: 'claim-1',
        match_method: 'llm',
        match_confidence: 'medium',
      }),
    })

    sandbox.processOldestPendingJob()

    expect(events(logged)).toContain('runner.llm_match_attempted')
    expect(jobs.get('dograh-1')?.claim_id).toBe('claim-1')
    expect(jobs.get('dograh-1')?.match_method).toBe('llm')
  })

  it('keeps the deterministic result and carries on when the LLM matcher throws', () => {
    const { sandbox, jobs, logged } = harness([dograhJob()], {
      matchClaim: () => ({ claim_id: '', match_method: 'none', match_confidence: 'low' }),
      matchClaimWithLlm: () => {
        throw new Error('openrouter down')
      },
    })

    sandbox.processOldestPendingJob()

    expect(events(logged)).toContain('runner.llm_match_failed')
    expect(jobs.get('dograh-1')?.status).toBe('transcribed')
    expect(jobs.get('dograh-1')?.match_method).toBe('none')
  })

  it('writes the transcription pass fields onto the job', () => {
    const { sandbox, jobs } = harness([dograhJob()], {
      runTranscriptionPass: () => ({
        transcript_master: 'adjuster: the roof',
        master_coverage: 0.99,
        transcription_sources: 'elevenlabs,qwen,dograh',
        extraction_input: 'master',
      }),
    })

    sandbox.processOldestPendingJob()

    expect(jobs.get('dograh-1')).toMatchObject({
      status: 'transcribed',
      master_coverage: 0.99,
      transcription_sources: 'elevenlabs,qwen,dograh',
      extraction_input: 'master',
    })
  })
})

describe('stage B', () => {
  it('extracts from the master and validates spans against the label-free haystack', () => {
    const { sandbox, extractCalls, validateCalls } = harness([
      dograhJob({ status: 'transcribed', claim_id: 'claim-1', extraction_input: 'master' }),
    ])

    sandbox.processOldestPendingJob()

    expect(extractCalls[0].transcript).toBe('master text')
    expect(extractCalls[0].transcriptSource).toBe('master')
    expect(validateCalls[0].transcript).toBe('master haystack')
  })

  it('passes the loaded phrase bank through to extraction', () => {
    const { sandbox, extractCalls } = harness(
      [dograhJob({ status: 'transcribed', claim_id: 'claim-1', extraction_input: 'master' })],
      { loadPhraseBank: () => ['minor granule loss consistent with age'] },
    )

    sandbox.processOldestPendingJob()

    expect(extractCalls[0].phraseBank).toEqual(['minor granule loss consistent with age'])
  })

  it('extracts from the Dograh transcript when stage A resolved to it', () => {
    const { sandbox, extractCalls, validateCalls } = harness([
      dograhJob({ status: 'transcribed', claim_id: 'claim-1', extraction_input: 'dograh' }),
    ])

    sandbox.processOldestPendingJob()

    expect(extractCalls[0].transcript).toBe('dograh text')
    expect(extractCalls[0].transcriptSource).toBe('dograh')
    expect(validateCalls[0].transcript).toBe('dograh text')
  })

  it('saves the extraction so the rendering half can be replayed without paying again', () => {
    const { sandbox, artifactWrites } = harness([
      dograhJob({ status: 'transcribed', claim_id: 'claim-1', extraction_input: 'master' }),
    ])

    sandbox.processOldestPendingJob()

    expect(artifactWrites).toHaveLength(1)
    expect(artifactWrites[0].job.capture_id).toBe('dograh-1')
    expect(artifactWrites[0].extraction).toMatchObject({ model: 'test-model' })
  })

  it('feeds the Dograh live export in as a cross-check hint, as before', () => {
    const { sandbox, extractCalls } = harness([
      dograhJob({
        status: 'transcribed',
        claim_id: 'claim-1',
        live_fields: JSON.stringify({ contacted_party_name: 'Henderson' }),
      }),
    ])

    sandbox.processOldestPendingJob()

    expect(extractCalls[0].liveExtraction).toEqual({ contacted_party_name: 'Henderson' })
  })

  it('logs and threads a dropped coverage detail into the notes generateDoc receives', () => {
    const generateDocCalls: unknown[][] = []
    const { sandbox, logged } = harness(
      [dograhJob({ status: 'transcribed', claim_id: 'claim-1' })],
      {
        dropCoverageRestatement: (validated: unknown) => ({
          validated,
          dropped: 'Coverage supporting detail, as extracted: "which is covered under the policy."',
        }),
        generateDoc: (...args: unknown[]) => {
          generateDocCalls.push(args)
          return { status: 'done', docUrl: 'https://doc', needsInputCount: 0 }
        },
      },
    )

    sandbox.processOldestPendingJob()

    expect(events(logged)).toContain('docgen.coverage_detail_dropped')
    const unplacedNotesArg = generateDocCalls[0][4] as string[]
    expect(unplacedNotesArg).toContain(
      'Coverage supporting detail, as extracted: "which is covered under the policy."',
    )
  })

  it('fails the job when docgen leaves tags unreplaced', () => {
    const { sandbox, jobs, logged } = harness(
      [dograhJob({ status: 'transcribed', claim_id: 'claim-1' })],
      {
        generateDoc: () => ({
          status: 'failed',
          error: 'Unreplaced tags: {{roof_status}}',
          docUrl: 'https://doc',
          needsInputCount: 1,
        }),
      },
    )

    sandbox.processOldestPendingJob()

    expect(events(logged)).toContain('runner.docgen_failed')
    expect(jobs.get('dograh-1')?.status).toBe('pending')
  })

  // docs/specs/022 phase 4 — an extractor-detected identity mismatch routes to
  // human review instead of generating a draft nobody can trust.
  describe('claim identity mismatch', () => {
    it('routes to needs_review and never calls generateDoc when the extractor flags a mismatch', () => {
      const generateDocCalls: unknown[] = []
      const { sandbox, jobs, logged } = harness(
        [dograhJob({ status: 'transcribed', claim_id: 'claim-1' })],
        {
          extractFields: () => ({
            fields: {},
            unplaced_notes: [
              'Transcript names Arnold at 1003 Venus Street, not the matched claim.',
            ],
            model: 'test-model',
            content: {
              claim_identity_mismatch: {
                mismatched: true,
                reason: 'Transcript names Arnold; claim context names Ray.',
              },
            },
          }),
          generateDoc: (...args: unknown[]) => {
            generateDocCalls.push(args)
            return { status: 'done', docUrl: 'https://doc', needsInputCount: 0 }
          },
        },
      )

      sandbox.processOldestPendingJob()

      expect(generateDocCalls).toHaveLength(0)
      expect(jobs.get('dograh-1')).toMatchObject({ status: 'needs_review' })
      expect(jobs.get('dograh-1')?.doc_url).toBeUndefined()
      const mismatchEvent = logged.find((l) => l.event === 'runner.claim_identity_mismatch')
      expect(mismatchEvent?.fields.reason).toBe('Transcript names Arnold; claim context names Ray.')
    })

    it('generates the draft as usual when the extractor reports no mismatch', () => {
      const { sandbox, jobs } = harness(
        [dograhJob({ status: 'transcribed', claim_id: 'claim-1' })],
        {
          extractFields: () => ({
            fields: {},
            unplaced_notes: [],
            model: 'test-model',
            content: { claim_identity_mismatch: { mismatched: false, reason: '' } },
          }),
        },
      )

      sandbox.processOldestPendingJob()

      expect(jobs.get('dograh-1')?.status).toBe('done')
    })
  })
})

describe('runPipelineTick', () => {
  it('adds the transcription columns before anything writes to them', () => {
    const order: string[] = []
    const { sandbox } = harness([], {
      reclaimStuckJobs: () => order.push('reclaim'),
      ensureJobsColumns: () => {
        order.push('ensure_columns')
        return ['call_folder_id']
      },
    })

    sandbox.runPipelineTick()

    expect(order).toEqual(['reclaim', 'ensure_columns'])
  })

  it('reports the columns it had to add', () => {
    const { sandbox, logged } = harness([], { ensureJobsColumns: () => ['call_folder_id'] })

    sandbox.runPipelineTick()

    const added = logged.find((l) => l.event === 'runner.jobs_columns_added')
    expect(added?.fields.columns).toBe('call_folder_id')
  })
})

// Spec 024. The drain replaces the every-minute Apps Script trigger, so these
// cover the two things that change: the loop-control decision (pure, so it is
// tested directly) and the lock discipline the loop depends on.
describe('shouldContinueDrain', () => {
  const BUDGET_MS = 240 * 1000
  const CAP = 20

  function decide(overrides: Record<string, unknown> = {}) {
    const { sandbox } = harness([])
    return sandbox.shouldContinueDrain({
      startedAtMs: 0,
      nowMs: 1000,
      iterations: 1,
      advancedLast: true,
      ...overrides,
    })
  }

  it('continues while there is work, time, and headroom', () => {
    expect(decide()).toEqual({ continue: true, reason: '' })
  })

  it('stops on an empty queue', () => {
    expect(decide({ advancedLast: false })).toEqual({ continue: false, reason: 'queue_empty' })
  })

  it('stops when the wall-clock budget is spent', () => {
    expect(decide({ nowMs: BUDGET_MS })).toEqual({
      continue: false,
      reason: 'budget_exhausted',
    })
  })

  it('keeps going at one millisecond under budget', () => {
    expect(decide({ nowMs: BUDGET_MS - 1 }).continue).toBe(true)
  })

  it('stops at the iteration cap', () => {
    expect(decide({ iterations: CAP })).toEqual({ continue: false, reason: 'iteration_cap' })
  })

  it('keeps going at one iteration under the cap', () => {
    expect(decide({ iterations: CAP - 1 }).continue).toBe(true)
  })

  // The boundary case the ordering exists for. Twenty advances INSIDE the budget
  // is the spin signature worth investigating; twenty advances that also ran the
  // clock out is just a busy morning, and reporting iteration_cap there would
  // send someone hunting a bug that isn't there.
  it('reports the budget, not the cap, when both trip together', () => {
    expect(decide({ iterations: CAP, nowMs: BUDGET_MS })).toEqual({
      continue: false,
      reason: 'budget_exhausted',
    })
  })

  // An empty queue outranks both: there is nothing left to do, so why the loop
  // ended is not interesting.
  it('reports an empty queue ahead of the cap and the budget', () => {
    expect(decide({ advancedLast: false, iterations: CAP, nowMs: BUDGET_MS }).reason).toBe(
      'queue_empty',
    )
  })
})

// The lock timeline is the point of these. withJobLock (jobs.js) takes the same
// script lock with a 30s tryLock and every webhook handler that mutates the Jobs
// tab holds it, so a drain that kept the lock across its loop would fail ingest
// for a quarter of every cycle.
function drainHarness(jobRows: Job[], overrides: Record<string, unknown> = {}) {
  const timeline: string[] = []
  let held = 0
  let maxHeld = 0
  const clock = { now: 1_000_000 }

  class FakeDate extends Date {
    static now() {
      return clock.now
    }
  }

  const built = harness(jobRows, {
    Date: FakeDate,
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          held += 1
          maxHeld = Math.max(maxHeld, held)
          timeline.push('acquire')
          return true
        },
        releaseLock: () => {
          held -= 1
          timeline.push('release')
        },
      }),
    },
    ...overrides,
  })

  return { ...built, timeline, clock, lock: { maxHeld: () => maxHeld } }
}

describe('drainPipeline', () => {
  it('carries a job from pending to done in one invocation', () => {
    const { sandbox, jobs } = drainHarness([dograhJob()])

    const result = sandbox.drainPipeline()

    expect(jobs.get('dograh-1')?.status).toBe('done')
    expect(result.advanced).toEqual(['dograh-1:transcribe', 'dograh-1:extract'])
    expect(result.iterations).toBe(2)
    expect(result.stopped_because).toBe('queue_empty')
    expect(result.ok).toBe(true)
  })

  it('never holds the script lock across two iterations', () => {
    const { sandbox, timeline, lock } = drainHarness([
      dograhJob({ capture_id: 'a', created_at: '2026-08-26T18:00:00Z' }),
      dograhJob({ capture_id: 'b', created_at: '2026-08-26T18:01:00Z' }),
    ])

    sandbox.drainPipeline()

    expect(lock.maxHeld()).toBe(1)
    // Strictly alternating: every acquire is answered by a release before the
    // next acquire, which is what leaves a gap for an inbound webhook.
    timeline.forEach((entry, index) => {
      expect(entry).toBe(index % 2 === 0 ? 'acquire' : 'release')
    })
  })

  it('reclaims and checks columns once per drain, not once per job', () => {
    let reclaims = 0
    let columnChecks = 0
    const { sandbox } = drainHarness(
      [
        dograhJob({ capture_id: 'a', created_at: '2026-08-26T18:00:00Z' }),
        dograhJob({ capture_id: 'b', created_at: '2026-08-26T18:01:00Z' }),
      ],
      {
        reclaimStuckJobs: () => {
          reclaims += 1
          return 2
        },
        ensureJobsColumns: () => {
          columnChecks += 1
          return []
        },
      },
    )

    const result = sandbox.drainPipeline()

    expect(reclaims).toBe(1)
    expect(columnChecks).toBe(1)
    expect(result.reclaimed).toBe(2)
  })

  it('stops once the wall-clock budget is spent', () => {
    const { sandbox, clock } = drainHarness([
      dograhJob({ capture_id: 'a', created_at: '2026-08-26T18:00:00Z' }),
      dograhJob({ capture_id: 'b', created_at: '2026-08-26T18:01:00Z' }),
    ])

    const startedAt = clock.now
    // Every stage burns three minutes, so the second check is past the 240s budget.
    sandbox.runTranscriptionStage = ((original) =>
      function (job: Job) {
        clock.now += 180 * 1000
        return original(job)
      })(sandbox.runTranscriptionStage)

    const result = sandbox.drainPipeline()

    expect(result.stopped_because).toBe('budget_exhausted')
    expect(clock.now - startedAt).toBeGreaterThanOrEqual(240 * 1000)
  })

  // A second drain firing while the first is mid-pass is expected under a 15
  // minute schedule and a 4 minute budget. It exits without doing work, and
  // reports ok so the n8n assertion stays green.
  it('exits cleanly when another drain already holds the lock', () => {
    const { sandbox } = harness([dograhJob()], {
      LockService: { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) },
    })

    const result = sandbox.drainPipeline()

    expect(result).toMatchObject({
      ok: true,
      iterations: 0,
      advanced: [],
      stopped_because: 'lock_unavailable',
    })
  })

  it('stops at the iteration cap rather than spinning to the execution cap', () => {
    // A job that advances forever without reaching a terminal status — the
    // pathology the cap exists for.
    const { sandbox } = drainHarness([dograhJob()], {
      getOldestJobByStatus: () => ({
        sheet: 'sheet',
        headers: ['capture_id'],
        job: dograhJob({ status: 'transcribed' }),
      }),
    })

    const result = sandbox.drainPipeline()

    expect(result.stopped_because).toBe('iteration_cap')
    expect(result.iterations).toBe(20)
  })
})

describe('processOldestPendingJob locking', () => {
  it('takes and releases the script lock itself', () => {
    const { sandbox, timeline } = drainHarness([dograhJob()])

    const result = sandbox.processOldestPendingJob()

    expect(timeline).toEqual(['acquire', 'release'])
    expect(result).toMatchObject({ advanced: true, capture_id: 'dograh-1', stage: 'transcribe' })
  })

  it('reports an empty queue without claiming an advance', () => {
    const { sandbox } = drainHarness([])

    expect(sandbox.processOldestPendingJob()).toMatchObject({
      advanced: false,
      reason: 'queue_empty',
    })
  })

  it('reports a contended lock rather than an empty queue', () => {
    const { sandbox } = harness([dograhJob()], {
      LockService: { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) },
    })

    expect(sandbox.processOldestPendingJob()).toMatchObject({
      advanced: false,
      reason: 'lock_unavailable',
    })
  })
})

describe('leaseJob', () => {
  // Spec 024 phase 3. The lease only has to outlast the 6-minute Apps Script
  // execution cap. It was 10 minutes, which cost three minutes of dead time
  // before a killed job could be reclaimed — barely visible when reclaim ran
  // every minute, three minutes on every recovery now that it runs once per
  // 15-minute drain.
  it('leases a job for seven minutes', () => {
    const { sandbox, leases, clock } = drainHarness([dograhJob()])

    sandbox.processOldestPendingJob()

    expect(leases[0].fields.lease_until).toBe(new Date(clock.now + 7 * 60 * 1000).toISOString())
  })
})
