import { describe, expect, it, vi } from 'vitest'
import { loadGs } from './loadGs'

type Job = Record<string, any>

const TAG_SCHEMA = {
  contacted_party_name: { label: 'Contacted party', type: 'string', required: true },
}

const SAVED_EXTRACTION = {
  capture_id: 'cap-1',
  claim_id: 'claim-1',
  model: 'saved-model',
  transcript_source: 'master',
  fields: { contacted_party_name: { value: 'Jane Smith', source_span: 'Jane Smith' } },
  unplaced_notes: ['Date of loss stated as 6/12.'],
}

function harness(job: Job, overrides: Record<string, unknown> = {}) {
  const jobs = new Map<string, Job>([[job.capture_id, { ...job }]])
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const written: Array<{ name: string; content: string }> = []
  const generated: Array<Record<string, any>> = []
  const upserts: Array<{ id: string; fields: Job }> = []

  const folderFiles = new Map<string, string>()
  const folder = {
    getFilesByName: (name: string) => {
      const content = folderFiles.get(name)
      let served = false
      return {
        hasNext: () => content !== undefined && !served,
        next: () => {
          served = true
          return { getBlob: () => ({ getDataAsString: () => content }) }
        },
      }
    },
  }

  // Any vendor-calling function is wired to throw. The point of the replay path
  // is that it cannot spend money, so the test asserts that by construction
  // rather than by counting calls after the fact.
  const forbidden = (name: string) => () => {
    throw new Error(`${name} must never be reached from a replay`)
  }

  const sandbox = loadGs(['apps/adjuster/src/runner.js', 'apps/adjuster/src/replay.js'], {
    logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    describeError: (err: Error) => ({ error: String(err.message ?? err), stack: 'stack' }),
    getConfig: () => 'x',
    getOptionalConfig: (_key: string, fallback: string) => fallback,
    getConfigList: () => [],

    getJobByCaptureId: (id: string) => jobs.get(id) ?? null,
    upsertJob: (id: string, fields: Job) => {
      upserts.push({ id, fields })
      jobs.set(id, { ...(jobs.get(id) ?? {}), ...fields })
    },
    getClaims: () => [{ claim_id: 'claim-1', insured_last_name: 'Henderson' }],
    loadEnums: () => TAG_SCHEMA,
    loadGlossary: () => [],

    getExistingCallFolder: () => folder,
    readCallArtifact: (fileId: string) => folderFiles.get(fileId) ?? '',
    writeCallArtifact: (_folder: unknown, name: string, content: string) => {
      written.push({ name, content })
      return `${name}-id`
    },
    resolveExtractionTranscript: () => ({
      source: 'master',
      transcript: 'master text',
      haystack: 'master haystack',
    }),

    extractFields: vi.fn(forbidden('extractFields')),
    runTranscriptionPass: forbidden('runTranscriptionPass'),
    UrlFetchApp: { fetch: forbidden('UrlFetchApp.fetch') },

    validateFields: (fields: Record<string, any>, haystack: string) => ({
      contacted_party_name: { valid: true, haystack, value: fields.contacted_party_name?.value },
    }),
    applyCalendarFallback: (validated: unknown) => validated,
    applyClaimPropertyFallback: (validated: unknown) => validated,
    dropCoverageRestatement: (validated: unknown) => ({ validated, dropped: null }),
    generateDoc: vi.fn(
      (
        docJob: Job,
        claim: Job | null,
        validated: Record<string, any>,
        tagSchema: unknown,
        unplacedNotes: string[],
        options: Record<string, unknown> | undefined,
      ) => {
        generated.push({ docJob, claim, validated, tagSchema, unplacedNotes, options })
        return { status: 'done', docUrl: 'https://doc', needsInputCount: 0 }
      },
    ),
    ...overrides,
  })

  return { sandbox, jobs, logged, written, generated, upserts, folderFiles }
}

const JOB = {
  capture_id: 'cap-1',
  claim_id: 'claim-1',
  source: 'dograh',
  call_folder_id: 'folder-1',
  extraction_artifact_id: 'artifact-1',
  live_fields: '{}',
}

describe('regenerateDraftFromArtifacts', () => {
  it('renders a draft without reaching extraction or any vendor call', () => {
    const h = harness(JOB)
    h.folderFiles.set('artifact-1', JSON.stringify(SAVED_EXTRACTION))

    const result = h.sandbox.regenerateDraftFromArtifacts('cap-1')

    expect(result.status).toBe('done')
    expect(h.sandbox.extractFields).not.toHaveBeenCalled()
    expect(h.generated).toHaveLength(1)
  })

  it('feeds the saved fields and notes through the live validate-and-render path', () => {
    const h = harness(JOB)
    h.folderFiles.set('artifact-1', JSON.stringify(SAVED_EXTRACTION))

    h.sandbox.regenerateDraftFromArtifacts('cap-1')

    const call = h.generated[0]
    expect(call.validated.contacted_party_name.value).toBe('Jane Smith')
    expect(call.validated.contacted_party_name.haystack).toBe('master haystack')
    expect(call.unplacedNotes).toEqual(['Date of loss stated as 6/12.'])
    expect(call.claim.claim_id).toBe('claim-1')
  })

  it('renders a scratch draft: no notification email, marked in the drafts folder', () => {
    const h = harness(JOB)
    h.folderFiles.set('artifact-1', JSON.stringify(SAVED_EXTRACTION))

    h.sandbox.regenerateDraftFromArtifacts('cap-1')

    expect(h.generated[0].options).toMatchObject({ notify: false })
    expect(String(h.generated[0].options.nameSuffix)).toContain('REPLAY')
  })

  it('leaves the Jobs row untouched — the row still points at the live draft', () => {
    const h = harness(JOB)
    h.folderFiles.set('artifact-1', JSON.stringify(SAVED_EXTRACTION))

    h.sandbox.regenerateDraftFromArtifacts('cap-1')

    expect(h.upserts).toEqual([])
  })

  it('falls back to the call folder when the job carries no artifact pointer', () => {
    const h = harness({ ...JOB, extraction_artifact_id: '' })
    h.folderFiles.set('extraction.json', JSON.stringify(SAVED_EXTRACTION))

    expect(h.sandbox.regenerateDraftFromArtifacts('cap-1').status).toBe('done')
  })

  it('names the paid escape hatch when no artifact exists at all', () => {
    const h = harness({ ...JOB, extraction_artifact_id: '' })

    expect(() => h.sandbox.regenerateDraftFromArtifacts('cap-1')).toThrow(/reExtractFromArtifacts/)
  })

  it('treats an unparseable artifact as missing rather than throwing on JSON', () => {
    const h = harness(JOB)
    h.folderFiles.set('artifact-1', 'not json')

    expect(() => h.sandbox.regenerateDraftFromArtifacts('cap-1')).toThrow(/No extraction.json/)
    expect(h.logged.map((l) => l.event)).toContain('replay.artifact_unparseable')
  })

  it('throws on an unknown capture_id', () => {
    const h = harness(JOB)

    expect(() => h.sandbox.regenerateDraftFromArtifacts('nope')).toThrow(/No job for capture_id/)
  })
})

describe('reExtractFromArtifacts', () => {
  function reExtractHarness() {
    const extractFields = vi.fn(() => ({
      fields: { contacted_party_name: { value: 'Re-extracted' } },
      unplaced_notes: [],
      model: 'fresh-model',
    }))
    return { extractFields, h: harness(JOB, { extractFields }) }
  }

  it('spends exactly one extraction call and no transcription', () => {
    const { extractFields, h } = reExtractHarness()

    const result = h.sandbox.reExtractFromArtifacts('cap-1')

    expect(extractFields).toHaveBeenCalledTimes(1)
    expect(extractFields.mock.calls[0][0]).toMatchObject({ transcript: 'master text' })
    expect(result.status).toBe('done')
  })

  it('saves the fresh extraction as the artifact a later free replay reads', () => {
    const { h } = reExtractHarness()

    h.sandbox.reExtractFromArtifacts('cap-1')

    const artifact = h.written.find((f) => f.name === 'extraction.json')
    expect(artifact).toBeDefined()
    expect(JSON.parse(artifact!.content)).toMatchObject({
      capture_id: 'cap-1',
      model: 'fresh-model',
      transcript_source: 'master',
      fields: { contacted_party_name: { value: 'Re-extracted' } },
    })
    expect(h.upserts).toContainEqual({
      id: 'cap-1',
      fields: { extraction_artifact_id: 'extraction.json-id' },
    })
  })

  it('refuses to run when there is no saved transcript to re-read', () => {
    const h = harness(JOB, {
      resolveExtractionTranscript: () => ({ source: '', transcript: '', haystack: '' }),
      extractFields: vi.fn(),
    })

    expect(() => h.sandbox.reExtractFromArtifacts('cap-1')).toThrow(/No saved transcript/)
    expect(h.sandbox.extractFields).not.toHaveBeenCalled()
  })
})

describe('writeExtractionArtifact', () => {
  it('degrades to a no-op when the call has no folder — never fails the job', () => {
    const h = harness(JOB, { getExistingCallFolder: () => null })

    expect(h.sandbox.writeExtractionArtifact(JOB, null, { source: 'master' }, { fields: {} })).toBe(
      '',
    )
    expect(h.written).toEqual([])
  })

  it('swallows a Drive failure and logs it', () => {
    const h = harness(JOB, {
      writeCallArtifact: () => {
        throw new Error('drive down')
      },
    })

    expect(h.sandbox.writeExtractionArtifact(JOB, null, { source: 'master' }, { fields: {} })).toBe(
      '',
    )
    expect(h.logged.map((l) => l.event)).toContain('replay.artifact_write_failed')
  })
})
