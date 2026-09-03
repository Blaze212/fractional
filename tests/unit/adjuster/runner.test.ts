import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

type Job = Record<string, any>

const CORE_CONFIG = { apiKey: 'x', model: 'x', fallbacks: [], adjusterName: 'Brandon' }

const TAG_SCHEMA = {
  contacted_party_name: { label: 'Contacted party', type: 'string', required: true },
}

function harness(jobRows: Job[], overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>()
  jobRows.forEach((job) => jobs.set(job.capture_id, { ...job }))

  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const leases: Array<{ capture_id: string; fields: Record<string, unknown> }> = []
  const coreDeps = {
    fetch: () => {
      throw new Error('the runner must not reach the network in a unit test')
    },
    logger: {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      logServerOnly: () => {},
    },
  }
  const extractCalls: Record<string, any>[] = []
  const validateCalls: Array<{ transcript: string }> = []
  const transcriptionCalls: Array<{ job: Job; claim: Job | null }> = []
  const artifactWrites: Array<{ job: Job; extraction: Record<string, any> }> = []

  const sandbox = loadGs(
    [
      'apps/adjuster/src/core/deps.js',
      'apps/adjuster/src/core/pipeline.js',
      'apps/adjuster/src/runner.js',
    ],
    {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      describeError: (err: Error) => ({ error: String(err.message ?? err), stack: 'stack' }),
      getConfig: () => 'x',
      getOptionalConfig: (_key: string, fallback: string) => fallback,
      getConfigList: () => [],
      // Defined in coreDeps.js, the Apps Script adapter for core's injected
      // dependencies (spec 021 phase 3.2). Stubbed rather than loaded so this
      // sandbox still exposes no network-capable global of any kind.
      buildCoreDeps: () => coreDeps,
      buildOpenRouterConfig: () => CORE_CONFIG,
      buildExtractionConfig: () => CORE_CONFIG,
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
      matchClaim: () => ({ claim_id: 'claim-1', match_method: 'exact', match_confidence: 'high' }),
      matchClaimWithLlm: () => ({ claim_id: '', match_method: 'none', match_confidence: 'low' }),
      loadEnums: () => TAG_SCHEMA,
      loadGlossary: () => [],

      runTranscriptionPass: vi.fn((job: Job, claim: Job | null) => {
        transcriptionCalls.push({ job, claim })
        return { extraction_input: 'dograh' }
      }),
      resolveExtractionTranscript: (job: Job) => ({
        source: job.extraction_input || 'dograh',
        transcript:
          job.extraction_input === 'master' ? 'master text' : String(job.transcript ?? ''),
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
    },
  )

  return {
    sandbox,
    coreDeps,
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
