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
