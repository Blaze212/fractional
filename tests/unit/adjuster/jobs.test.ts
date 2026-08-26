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

describe('promoteStaleAwaitingTranscript', () => {
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const fresh = new Date().toISOString()

  function row(captureId: string, createdAt: string, status: string, transcript = '') {
    return ['', '', '', '', '', '', '', '', ''].map((_, i) => {
      if (i === HEADERS.indexOf('capture_id')) return captureId
      if (i === HEADERS.indexOf('created_at')) return createdAt
      if (i === HEADERS.indexOf('status')) return status
      if (i === HEADERS.indexOf('transcript')) return transcript
      return ''
    })
  }

  it('promotes a stale awaiting_recording job without relabelling its transcript source', () => {
    const { sandbox, sheet } = harness([row('a', stale, 'awaiting_recording', 'roof is 3-tab')])

    sandbox.promoteStaleAwaitingTranscript()

    expect(column(sheet, 'status', 1)).toBe('pending')
    expect(column(sheet, 'transcript_source', 1)).toBe('')
  })

  it('promotes a stale awaiting_transcript job and marks it for direct transcription', () => {
    const { sandbox, sheet } = harness([row('a', stale, 'awaiting_transcript')])

    sandbox.promoteStaleAwaitingTranscript()

    expect(column(sheet, 'status', 1)).toBe('pending')
    expect(column(sheet, 'transcript_source', 1)).toBe('deepgram-direct')
  })

  it('leaves a job inside the grace window alone', () => {
    const { sandbox, sheet } = harness([row('a', fresh, 'awaiting_recording', 'roof is 3-tab')])

    sandbox.promoteStaleAwaitingTranscript()

    expect(column(sheet, 'status', 1)).toBe('awaiting_recording')
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
