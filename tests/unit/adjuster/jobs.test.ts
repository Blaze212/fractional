import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

const HEADERS = [
  'capture_id',
  'created_at',
  'updated_at',
  'duration_sec',
  'recording_url',
  'audio_drive_id',
  'transcript',
  'transcript_source',
  'status',
]

function fakeSheet(rows: string[][] = []) {
  const values: string[][] = [HEADERS.slice(), ...rows]

  return {
    values,
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length,
    appendRow: (row: string[]) => values.push(row.slice()),
    getRange: (rowIndex: number, col: number) => ({
      setValue: (value: string) => {
        values[rowIndex - 1][col - 1] = value
      },
      setValues: ([row]: string[][]) => {
        values[rowIndex - 1] = row.slice()
      },
    }),
  }
}

function harness(rows: string[][] = []) {
  const sheet = fakeSheet(rows)
  const lock = { acquired: 0, released: 0, grant: true }

  const sandbox = loadGs('apps/adjuster/src/jobs.js', {
    getConfig: () => 'sheet-1',
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush: () => {} },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lock.grant) lock.acquired += 1
          return lock.grant
        },
        releaseLock: () => {
          lock.released += 1
        },
      }),
    },
  })

  return { sandbox, sheet, lock }
}

function column(sheet: ReturnType<typeof fakeSheet>, name: string, rowIndex: number) {
  return sheet.values[rowIndex][HEADERS.indexOf(name)]
}

describe('upsertJob', () => {
  it('appends rather than resolving a row index up front, so a concurrent insert cannot collide', () => {
    const { sandbox, sheet } = harness()

    sandbox.upsertJob('capture-a', { transcript: 'first' })
    sandbox.upsertJob('capture-b', { transcript: 'second' })

    expect(sheet.values).toHaveLength(3)
    expect(column(sheet, 'capture_id', 1)).toBe('capture-a')
    expect(column(sheet, 'capture_id', 2)).toBe('capture-b')
  })

  it('merges into an existing row without blanking untouched columns', () => {
    const { sandbox, sheet } = harness()

    sandbox.upsertJob('capture-a', { transcript: 'roof is 3-tab', transcript_source: 'telnyx' })
    sandbox.upsertJob('capture-a', { recording_url: 'https://s3/x.mp3', status: 'pending' })

    expect(sheet.values).toHaveLength(2)
    expect(column(sheet, 'transcript', 1)).toBe('roof is 3-tab')
    expect(column(sheet, 'recording_url', 1)).toBe('https://s3/x.mp3')
    expect(column(sheet, 'status', 1)).toBe('pending')
  })
})

describe('withJobLock', () => {
  it('releases the lock even when the callback throws', () => {
    const { sandbox, lock } = harness()

    expect(() =>
      sandbox.withJobLock(() => {
        throw new Error('sheet write failed')
      }),
    ).toThrow('sheet write failed')
    expect(lock.acquired).toBe(1)
    expect(lock.released).toBe(1)
  })

  it('throws instead of writing unserialised when the lock cannot be taken', () => {
    const { sandbox, lock } = harness()
    lock.grant = false

    expect(() => sandbox.withJobLock(() => 'never')).toThrow('Timed out waiting for the job lock')
  })
})

describe('ensureJobsColumns', () => {
  const TRANSCRIPTION_COLUMNS = [
    'call_folder_id',
    'transcript_elevenlabs_id',
    'transcript_qwen_id',
    'transcript_master',
    'transcript_master_id',
    'master_coverage',
    'transcription_sources',
    'extraction_input',
  ]

  function jobsSheetHarness() {
    const values: string[][] = [HEADERS.slice()]
    const sheet = {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getLastColumn: () => values[0].length,
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          if (values[rowIndex - 1].length < col) values[rowIndex - 1].length = col
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }

    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    })

    return { sandbox, sheet }
  }

  it('adds every transcription column to a Jobs sheet that lacks them', () => {
    const { sandbox, sheet } = jobsSheetHarness()

    const added = sandbox.ensureJobsColumns(TRANSCRIPTION_COLUMNS)

    expect(added).toEqual(TRANSCRIPTION_COLUMNS)
    expect(sheet.values[0].slice(HEADERS.length)).toEqual(TRANSCRIPTION_COLUMNS)
  })

  it('is a no-op on a sheet that already has them', () => {
    const { sandbox, sheet } = jobsSheetHarness()

    sandbox.ensureJobsColumns(TRANSCRIPTION_COLUMNS)
    const added = sandbox.ensureJobsColumns(TRANSCRIPTION_COLUMNS)

    expect(added).toEqual([])
    expect(sheet.values[0]).toHaveLength(HEADERS.length + TRANSCRIPTION_COLUMNS.length)
  })
})

describe('getOldestJobByStatus', () => {
  const HEADERS_WITH_CREATED = HEADERS

  function row(captureId: string, createdAt: string, status: string) {
    return HEADERS_WITH_CREATED.map((header) => {
      if (header === 'capture_id') return captureId
      if (header === 'created_at') return createdAt
      if (header === 'status') return status
      return ''
    })
  }

  it('returns the oldest job in the requested status', () => {
    const { sandbox } = harness([
      row('newer', '2026-08-26T19:00:00Z', 'transcribed'),
      row('older', '2026-08-26T17:00:00Z', 'transcribed'),
      row('pending', '2026-08-26T16:00:00Z', 'pending'),
    ])

    expect(sandbox.getOldestJobByStatus('transcribed').job.capture_id).toBe('older')
    expect(sandbox.getOldestJobByStatus('pending').job.capture_id).toBe('pending')
  })

  it('returns no job when nothing is in that status', () => {
    const { sandbox } = harness([row('a', '2026-08-26T17:00:00Z', 'done')])

    expect(sandbox.getOldestJobByStatus('transcribed').job).toBeNull()
  })
})

describe('reclaimStuckJobs', () => {
  const expired = new Date(Date.now() - 60 * 1000).toISOString()

  function leaseHarness(status: string, attempts: number) {
    const headers = HEADERS.concat(['lease_until', 'attempts', 'error'])
    const values: string[][] = [
      headers,
      headers.map((header) => {
        if (header === 'capture_id') return 'dograh-1'
        if (header === 'status') return status
        if (header === 'lease_until') return expired
        if (header === 'attempts') return String(attempts)
        return ''
      }),
    ]

    const sheet = {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }

    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    })

    return { sandbox, values, headers }
  }

  it('returns a job stuck past its lease in transcribing to pending', () => {
    const { sandbox, values, headers } = leaseHarness('transcribing', 1)

    sandbox.reclaimStuckJobs()

    expect(values[1][headers.indexOf('status')]).toBe('pending')
    expect(values[1][headers.indexOf('lease_until')]).toBe('')
  })

  it('fails a transcribing job that has already burned its attempts', () => {
    const { sandbox, values, headers } = leaseHarness('transcribing', 3)

    sandbox.reclaimStuckJobs()

    expect(values[1][headers.indexOf('status')]).toBe('failed')
  })

  it('leaves a transcribed job alone — it is queued for stage B, not leased', () => {
    const { sandbox, values, headers } = leaseHarness('transcribed', 0)

    sandbox.reclaimStuckJobs()

    expect(values[1][headers.indexOf('status')]).toBe('transcribed')
  })
})

describe('withJobLock flushing', () => {
  it('flushes buffered sheet writes before releasing the lock', () => {
    const order: string[] = []
    const sheet = fakeSheet()

    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: {
        openById: () => ({ getSheetByName: () => sheet }),
        flush: () => order.push('flush'),
      },
      LockService: {
        getScriptLock: () => ({
          tryLock: () => true,
          releaseLock: () => order.push('release'),
        }),
      },
    })

    sandbox.withJobLock(() => order.push('write'))

    expect(order).toEqual(['write', 'flush', 'release'])
  })
})

describe('upsertClaim', () => {
  const CLAIM_HEADERS = [
    'claim_id',
    'appt_start',
    'appt_end',
    'insured_last_name',
    'address_line1',
    'city',
    'claim_number',
    'vendor',
    'calendar_fields',
  ]

  function fakeClaimsSheet(rows: string[][] = [], headers = CLAIM_HEADERS) {
    const values: string[][] = [headers.slice(), ...rows]

    return {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getLastRow: () => values.length,
      getLastColumn: () => values[0].length,
      appendRow: (row: string[]) => values.push(row.slice()),
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          if (values[rowIndex - 1].length < col) values[rowIndex - 1].length = col
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }
  }

  function claimColumn(sheet: ReturnType<typeof fakeClaimsSheet>, name: string, rowIndex: number) {
    return sheet.values[rowIndex][CLAIM_HEADERS.indexOf(name)]
  }

  function claimsHarness(rows: string[][] = []) {
    const sheet = fakeClaimsSheet(rows)
    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush: () => {} },
    })

    return { sandbox, sheet }
  }

  it('appends a new claim row keyed by claim_id (the calendar event ID)', () => {
    const { sandbox, sheet } = claimsHarness()

    sandbox.upsertClaim('event-1', { claim_number: 'CLF-1', insured_last_name: 'TALLEY' })

    expect(sheet.values).toHaveLength(2)
    expect(claimColumn(sheet, 'claim_id', 1)).toBe('event-1')
    expect(claimColumn(sheet, 'claim_number', 1)).toBe('CLF-1')
  })

  it('merges into the existing row for that event instead of duplicating it', () => {
    const { sandbox, sheet } = claimsHarness()

    sandbox.upsertClaim('event-1', { claim_number: 'CLF-1', city: 'Concord' })
    sandbox.upsertClaim('event-1', { city: 'Charlotte', vendor: 'IBIS' })

    expect(sheet.values).toHaveLength(2)
    expect(claimColumn(sheet, 'claim_number', 1)).toBe('CLF-1')
    expect(claimColumn(sheet, 'city', 1)).toBe('Charlotte')
    expect(claimColumn(sheet, 'vendor', 1)).toBe('IBIS')
  })
})

describe('ensureClaimsColumns', () => {
  const CLAIM_HEADERS = [
    'claim_id',
    'appt_start',
    'appt_end',
    'insured_last_name',
    'address_line1',
    'city',
    'claim_number',
    'vendor',
    'calendar_fields',
  ]

  function fakeSheetWithHeaders(headers: string[]) {
    const values: string[][] = [headers.slice()]

    return {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getLastColumn: () => values[0].length,
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          if (values[rowIndex - 1].length < col) values[rowIndex - 1].length = col
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }
  }

  it('appends only the headers that are actually missing, in order', () => {
    const sheet = fakeSheetWithHeaders(['claim_id', 'insured_last_name', 'address_line1', 'city'])
    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    })

    const added = sandbox.ensureClaimsColumns(CLAIM_HEADERS)

    expect(added).toEqual(['appt_start', 'appt_end', 'claim_number', 'vendor', 'calendar_fields'])
    expect(sheet.values[0]).toEqual([
      'claim_id',
      'insured_last_name',
      'address_line1',
      'city',
      'appt_start',
      'appt_end',
      'claim_number',
      'vendor',
      'calendar_fields',
    ])
  })

  it('adds nothing and reports no missing columns when the sheet already has them all', () => {
    const sheet = fakeSheetWithHeaders(CLAIM_HEADERS)
    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    })

    const added = sandbox.ensureClaimsColumns(CLAIM_HEADERS)

    expect(added).toEqual([])
    expect(sheet.values[0]).toEqual(CLAIM_HEADERS)
  })
})

describe('claim candidates cache', () => {
  function fakeCache(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial))
    const puts: Array<{ key: string; value: string; ttl: number }> = []

    return {
      store,
      puts,
      get: (key: string) => store.get(key) ?? null,
      put: (key: string, value: string, ttl: number) => {
        store.set(key, value)
        puts.push({ key, value, ttl })
      },
    }
  }

  function claimsHarness(claimRows: string[][], cache: ReturnType<typeof fakeCache>) {
    const headers = ['claim_id', 'insured_last_name']
    const sheet = {
      getDataRange: () => ({ getValues: () => [headers, ...claimRows] }),
    }

    return loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
      CacheService: { getScriptCache: () => cache },
    })
  }

  it('refreshClaimCandidatesCache reads the Claims sheet and writes it to the script cache', () => {
    const cache = fakeCache()
    const sandbox = claimsHarness([['evt-1', 'Love']], cache)

    const claims = sandbox.refreshClaimCandidatesCache()

    expect(claims).toEqual([{ claim_id: 'evt-1', insured_last_name: 'Love', _rowIndex: 2 }])
    expect(cache.puts).toHaveLength(1)
    expect(cache.puts[0].key).toBe('claim_candidates_v1')
    expect(JSON.parse(cache.puts[0].value)).toEqual(claims)
    expect(cache.puts[0].ttl).toBe(21600)
  })

  it('getCachedClaims returns the cached value on a hit without reading the Sheet', () => {
    const cache = fakeCache({
      claim_candidates_v1: JSON.stringify([{ claim_id: 'cached-1', insured_last_name: 'Cached' }]),
    })
    const getDataRange = () => {
      throw new Error('Sheet should not be read on a cache hit')
    }
    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: {
        openById: () => ({ getSheetByName: () => ({ getDataRange }) }),
      },
      CacheService: { getScriptCache: () => cache },
    })

    const claims = sandbox.getCachedClaims()

    expect(claims).toEqual([{ claim_id: 'cached-1', insured_last_name: 'Cached' }])
  })

  it('getCachedClaims falls back to a live read and repopulates the cache on a miss', () => {
    const cache = fakeCache()
    const sandbox = claimsHarness([['evt-2', 'Barnes']], cache)

    const claims = sandbox.getCachedClaims()

    expect(claims).toEqual([{ claim_id: 'evt-2', insured_last_name: 'Barnes', _rowIndex: 2 }])
    expect(cache.store.get('claim_candidates_v1')).toBe(JSON.stringify(claims))
  })

  it('getCachedClaims falls back to a live read when the cached entry is corrupt JSON', () => {
    const cache = fakeCache({ claim_candidates_v1: 'not-json{' })
    const sandbox = claimsHarness([['evt-3', 'Adams']], cache)

    const claims = sandbox.getCachedClaims()

    expect(claims).toEqual([{ claim_id: 'evt-3', insured_last_name: 'Adams', _rowIndex: 2 }])
  })

  it('getCachedClaims falls back to a live read when the cached entry parses but is not an array', () => {
    const cache = fakeCache({ claim_candidates_v1: JSON.stringify({ not: 'an array' }) })
    const sandbox = claimsHarness([['evt-4', 'Ortiz']], cache)

    const claims = sandbox.getCachedClaims()

    expect(claims).toEqual([{ claim_id: 'evt-4', insured_last_name: 'Ortiz', _rowIndex: 2 }])
  })

  it('refreshClaimCandidatesCache returns the live claims even when the cache write itself throws', () => {
    const claimRows = [['evt-5', 'Diaz']]
    const headers = ['claim_id', 'insured_last_name']
    const sheet = {
      getDataRange: () => ({ getValues: () => [headers, ...claimRows] }),
    }
    const cache = {
      get: () => null,
      put: () => {
        throw new Error('cache quota exceeded')
      },
    }
    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
      CacheService: { getScriptCache: () => cache },
    })

    const claims = sandbox.getCachedClaims()

    expect(claims).toEqual([{ claim_id: 'evt-5', insured_last_name: 'Diaz', _rowIndex: 2 }])
  })
})

// Review UI prototype (option A — native Apps Script HtmlService), see
// docs/specs/012-adjuster-review-webapp.md and reviewUi.js. Unlike Jobs/
// Claims/Raw, the Review tab is new and did not exist on any spreadsheet
// provisioned before this prototype, so getReviewSheet() has to create it.
describe('Review tab (option A prototype)', () => {
  const REVIEW_HEADERS = [
    'job_id',
    'tag',
    'label',
    'section',
    'source_span',
    'confidence',
    'status',
    'resolved_value',
    'decided_at',
    'created_at',
  ]

  function emptySheet() {
    const values: string[][] = []
    return {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getLastRow: () => values.length,
      appendRow: (row: string[]) => values.push(row.slice()),
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }
  }

  function fakeReviewSheet(rows: string[][] = []) {
    const values: string[][] = [REVIEW_HEADERS.slice(), ...rows]
    return {
      values,
      getDataRange: () => ({ getValues: () => values }),
      getLastRow: () => values.length,
      appendRow: (row: string[]) => values.push(row.slice()),
      getRange: (rowIndex: number, col: number) => ({
        setValue: (value: string) => {
          values[rowIndex - 1][col - 1] = value
        },
      }),
    }
  }

  function reviewHarness(jobsRows: string[][] = [], reviewSheetExists = true) {
    const jobsSheet = fakeSheet(jobsRows)
    let reviewSheet: ReturnType<typeof fakeReviewSheet> | null = reviewSheetExists
      ? fakeReviewSheet()
      : null
    const insertSheetCalls: string[] = []

    const spreadsheet = {
      getSheetByName: (name: string) => {
        if (name === 'Jobs') return jobsSheet
        if (name === 'Review') return reviewSheet
        return null
      },
      insertSheet: (name: string) => {
        insertSheetCalls.push(name)
        reviewSheet = emptySheet()
        return reviewSheet
      },
    }

    const sandbox = loadGs('apps/adjuster/src/jobs.js', {
      getConfig: () => 'sheet-1',
      SpreadsheetApp: { openById: () => spreadsheet, flush: () => {} },
    })

    return { sandbox, jobsSheet, getReviewSheet: () => reviewSheet, insertSheetCalls }
  }

  it('creates the Review tab with headers on first use', () => {
    const { sandbox, insertSheetCalls, getReviewSheet } = reviewHarness([], false)

    sandbox.getReviewSheet()

    expect(insertSheetCalls).toEqual(['Review'])
    expect(getReviewSheet()!.values[0]).toEqual(REVIEW_HEADERS)
  })

  it('does not recreate an existing Review tab', () => {
    const { sandbox, insertSheetCalls } = reviewHarness([], true)

    sandbox.getReviewSheet()

    expect(insertSheetCalls).toEqual([])
  })

  it('upsertReviewItems inserts a pending row per item', () => {
    const { sandbox, getReviewSheet } = reviewHarness()

    sandbox.upsertReviewItems('cap-1', [
      {
        tag: 'contacted_party_name',
        label: 'Contacted party',
        section: 'Assignment',
        source_span: 'talked to Jane',
        confidence: '',
      },
    ])

    const values = getReviewSheet()!.values
    expect(values).toHaveLength(2)
    expect(values[1][REVIEW_HEADERS.indexOf('job_id')]).toBe('cap-1')
    expect(values[1][REVIEW_HEADERS.indexOf('tag')]).toBe('contacted_party_name')
    expect(values[1][REVIEW_HEADERS.indexOf('status')]).toBe('pending')
  })

  it('refreshes field metadata on re-ingest without clobbering an existing decision', () => {
    const { sandbox, getReviewSheet } = reviewHarness()

    sandbox.upsertReviewItems('cap-1', [
      {
        tag: 'contacted_party_name',
        label: 'Contacted party',
        section: 'Assignment',
        source_span: 'talked to Jane',
        confidence: '',
      },
    ])
    sandbox.updateReviewItemDecision('cap-1', 'contacted_party_name', 'accepted', 'Jane Smith')
    sandbox.upsertReviewItems('cap-1', [
      {
        tag: 'contacted_party_name',
        label: 'Contacted party',
        section: 'Assignment',
        source_span: 'talked to Jane (re-extracted)',
        confidence: '',
      },
    ])

    const values = getReviewSheet()!.values
    expect(values).toHaveLength(2)
    expect(values[1][REVIEW_HEADERS.indexOf('source_span')]).toBe('talked to Jane (re-extracted)')
    expect(values[1][REVIEW_HEADERS.indexOf('status')]).toBe('accepted')
    expect(values[1][REVIEW_HEADERS.indexOf('resolved_value')]).toBe('Jane Smith')
  })

  it('getReviewItemsForJob only returns rows for that job', () => {
    const { sandbox } = reviewHarness()

    sandbox.upsertReviewItems('cap-1', [{ tag: 'a', label: 'A', section: 'S' }])
    sandbox.upsertReviewItems('cap-2', [{ tag: 'b', label: 'B', section: 'S' }])

    expect(sandbox.getReviewItemsForJob('cap-1').map((row: { tag: string }) => row.tag)).toEqual([
      'a',
    ])
  })

  it('updateReviewItemDecision throws for an unknown (job_id, tag) pair', () => {
    const { sandbox } = reviewHarness()

    expect(() => sandbox.updateReviewItemDecision('cap-1', 'missing', 'accepted', '')).toThrow(
      'No review item for job_id=cap-1 tag=missing',
    )
  })

  it('listJobsNeedingReview returns only Jobs rows in needs_review status', () => {
    const { sandbox } = reviewHarness([
      HEADERS.map((h) => (h === 'capture_id' ? 'cap-1' : h === 'status' ? 'needs_review' : '')),
      HEADERS.map((h) => (h === 'capture_id' ? 'cap-2' : h === 'status' ? 'done' : '')),
    ])

    expect(
      sandbox.listJobsNeedingReview().map((job: { capture_id: string }) => job.capture_id),
    ).toEqual(['cap-1'])
  })
})
