import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

type FakeEvent = {
  id: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
}

function fakeEvent(overrides: Partial<FakeEvent> = {}) {
  const e: FakeEvent = {
    id: 'event-1',
    title: 'TALLEY - CLF-00153289 IBIS',
    description: '',
    location: '',
    start: '2026-08-19T10:00:00Z',
    end: '2026-08-19T12:00:00Z',
    ...overrides,
  }

  return {
    getId: () => e.id,
    getTitle: () => e.title,
    getDescription: () => e.description ?? '',
    getLocation: () => e.location ?? '',
    getStartTime: () => new Date(e.start),
    getEndTime: () => new Date(e.end),
  }
}

function harness(
  opts: {
    openRouterFields?: Record<string, { value: string }>
    throwOnLLM?: boolean
    webSearchContent?: string
    throwOnWebSearch?: boolean
  } = {},
) {
  const claims = new Map<string, Record<string, unknown>>()
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const lockCalls: number[] = []
  const llmCalls: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const webSearchCalls: Array<{ messages: Array<{ role: string; content: string }> }> = []

  const sandbox = loadGs('apps/adjuster/src/calendarSync.js', {
    getConfig: (key: string) => {
      if (key === 'CALENDAR_ID') return 'calendar-1'
      if (key === 'OPENROUTER_API_KEY') return 'key'
      if (key === 'OPENROUTER_MODEL') return 'model'
      if (key === 'OPENAI_WEB_SEARCH_MODEL') return 'openai/gpt-5.4-mini'
      throw new Error('Missing script property: ' + key)
    },
    getConfigList: () => [],
    loadEnums: () => ({
      bedroom_count: {
        type: 'enum',
        label: 'Bedroom count',
        values: ['1', '2', '3', '4', '5', '6'],
      },
      bathroom_count: {
        type: 'enum',
        label: 'Bathroom count',
        values: ['1', '2', '3', '4', '5', '6'],
      },
      square_footage: { type: 'string', label: 'Interior square footage' },
      year_built: { type: 'string', label: 'Year built' },
      roof_age_years: { type: 'string', label: 'Roof age (years)' },
      dwelling_stories: {
        type: 'enum',
        label: 'Dwelling stories',
        values: ['1 story', '2 story', '3 story', '4 story'],
      },
    }),
    formatTagList: (tagSchema: Record<string, unknown>) => Object.keys(tagSchema).join(', '),
    buildExtractionSchema: () => ({}),
    callOpenRouter: (config: { messages: Array<{ role: string; content: string }> }) => {
      llmCalls.push(config)
      if (opts.throwOnLLM) throw new Error('openrouter down')
      return { fields: opts.openRouterFields || {} }
    },
    callOpenRouterWebSearch: (config: { messages: Array<{ role: string; content: string }> }) => {
      webSearchCalls.push(config)
      if (opts.throwOnWebSearch) throw new Error('web search down')
      return { content: opts.webSearchContent ?? JSON.stringify({}) }
    },
    withJobLock: (fn: () => unknown) => {
      lockCalls.push(1)
      return fn()
    },
    upsertClaim: (claimId: string, fields: Record<string, unknown>) => {
      claims.set(claimId, fields)
    },
    logEvent: (event: string, fields: Record<string, unknown>) => {
      logged.push({ event, fields })
    },
    describeError: (err: Error) => ({ error: String(err.message || err), stack: '' }),
  })

  return {
    sandbox,
    claims,
    logged,
    lockCalls,
    llmCalls,
    llmCallCount: () => llmCalls.length,
    webSearchCalls,
  }
}

describe('buildCalendarTagSchema', () => {
  it('carries the real enum allowed-values list through from enums.json, not a bare placeholder', () => {
    const { sandbox } = harness()

    const schema = sandbox.buildCalendarTagSchema()

    expect(schema.dwelling_stories).toEqual({
      type: 'enum',
      label: 'Dwelling stories',
      values: ['1 story', '2 story', '3 story', '4 story'],
    })
    expect(schema.bedroom_count.values).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(schema.insured_name).toEqual({ type: 'string', label: 'Insured name' })
  })
})

describe('parseEventTitle', () => {
  it('splits the real invite title into name, claim number, vendor', () => {
    const { sandbox } = harness()
    const result = sandbox.parseEventTitle('TALLEY - CLF-00153289 IBIS')

    expect(result).toEqual({
      insured_last_name: 'TALLEY',
      claim_number: 'CLF-00153289',
      vendor: 'IBIS',
    })
  })

  it("does not split on the claim number's own internal hyphen", () => {
    const { sandbox } = harness()
    const result = sandbox.parseEventTitle('OBRIEN-SMITH - CLF-999 STATE FARM')

    expect(result.insured_last_name).toBe('OBRIEN-SMITH')
    expect(result.claim_number).toBe('CLF-999')
  })

  it('returns empty fields for a title with no separator', () => {
    const { sandbox } = harness()
    const result = sandbox.parseEventTitle('Just a note')

    expect(result).toEqual({ insured_last_name: '', claim_number: '', vendor: '' })
  })

  it('the third token is treated as vendor, not carrier, since it recurs across unrelated claims', () => {
    const { sandbox } = harness()

    const a = sandbox.parseEventTitle('TALLEY - CLF-00153289    IBIS')
    const b = sandbox.parseEventTitle('MORRIS - 126981    IBIS')

    expect(a.vendor).toBe('IBIS')
    expect(b.vendor).toBe('IBIS')
  })
})

describe('parseAddress', () => {
  it('parses the real invite address line', () => {
    const { sandbox } = harness()
    const result = sandbox.parseAddress('', '5139 Alderman Rd. Concord NC 28025')

    expect(result).toEqual({ address_line1: '5139 Alderman Rd.', city: 'Concord' })
  })

  it('parses a comma-separated location field (production regression: GUBANEZ claim)', () => {
    const { sandbox } = harness()
    const result = sandbox.parseAddress('1104 S Zion St, Landis, NC 28088', '')

    expect(result).toEqual({ address_line1: '1104 S Zion St', city: 'Landis' })
  })

  it('prefers the event location field over the description', () => {
    const { sandbox } = harness()
    const result = sandbox.parseAddress(
      '10 Main St Charlotte NC 28202',
      '5139 Alderman Rd. Concord NC 28025',
    )

    expect(result).toEqual({ address_line1: '10 Main St', city: 'Charlotte' })
  })

  it('falls back to the description when location is unparseable', () => {
    const { sandbox } = harness()
    const result = sandbox.parseAddress('see note', '5139 Alderman Rd. Concord NC 28025')

    expect(result).toEqual({ address_line1: '5139 Alderman Rd.', city: 'Concord' })
  })

  it('returns empty fields when nothing matches', () => {
    const { sandbox } = harness()
    const result = sandbox.parseAddress('', 'Call when on your way')

    expect(result).toEqual({ address_line1: '', city: '' })
  })
})

describe('resolveFullAddressText', () => {
  it('returns the full matched string including state and zip, not just street/city', () => {
    const { sandbox } = harness()
    const result = sandbox.resolveFullAddressText('5139 Alderman Rd. Concord NC 28025', '')
    expect(result).toBe('5139 Alderman Rd. Concord NC 28025')
  })

  it('falls back to the description first line the same way parseAddress does', () => {
    const { sandbox } = harness()
    const result = sandbox.resolveFullAddressText('see note', '1104 S Zion St, Landis, NC 28088')
    expect(result).toBe('1104 S Zion St, Landis, NC 28088')
  })

  it('returns an empty string when nothing matches', () => {
    const { sandbox } = harness()
    expect(sandbox.resolveFullAddressText('', 'Call when on your way')).toBe('')
  })

  it('drops the ZIP+4 extension, which suppresses Zillow/Redfin results', () => {
    const { sandbox } = harness()
    const result = sandbox.resolveFullAddressText('5139 Alderman Rd. Concord NC 28025-1234', '')
    expect(result).toBe('5139 Alderman Rd. Concord NC 28025')
  })

  it('drops the ZIP+4 extension from a comma-separated location too', () => {
    const { sandbox } = harness()
    const result = sandbox.resolveFullAddressText('1104 S Zion St, Landis, NC 28088-9876', '')
    expect(result).toBe('1104 S Zion St, Landis, NC 28088')
  })
})

describe('parsePropertyLookupResponse', () => {
  it('parses a well-formed JSON response', () => {
    const { sandbox } = harness()
    const result = sandbox.parsePropertyLookupResponse(
      JSON.stringify({
        year_built: '1979',
        bedrooms: '3',
        bathrooms: '2',
        square_footage: '1508',
        source_url: 'https://example.com/property',
      }),
    )
    expect(result).toEqual({
      year_built: '1979',
      bedrooms: '3',
      bathrooms: '2',
      square_footage: '1508',
      source_url: 'https://example.com/property',
    })
  })

  it('strips a markdown code fence the model wraps the JSON in despite instructions not to', () => {
    const { sandbox } = harness()
    const result = sandbox.parsePropertyLookupResponse(
      '```json\n' + JSON.stringify({ year_built: '2001', source_url: 'https://x.com/y' }) + '\n```',
    )
    expect(result.year_built).toBe('2001')
    expect(result.source_url).toBe('https://x.com/y')
  })

  it('discards every field when source_url is missing, since a fact with no page behind it may be fabricated', () => {
    const { sandbox } = harness()
    const result = sandbox.parsePropertyLookupResponse(
      JSON.stringify({
        year_built: '1973',
        bedrooms: '3',
        bathrooms: '2',
        square_footage: '1394',
      }),
    )
    expect(result).toEqual({
      year_built: '',
      bedrooms: '',
      bathrooms: '',
      square_footage: '',
      source_url: '',
    })
  })

  it('returns all-empty on unparseable content instead of throwing', () => {
    const { sandbox } = harness()
    expect(sandbox.parsePropertyLookupResponse('not json at all')).toEqual({
      year_built: '',
      bedrooms: '',
      bathrooms: '',
      square_footage: '',
      source_url: '',
    })
  })
})

describe('syncEventToClaim', () => {
  it('parses title and address, extracts description fields via LLM, and upserts the claim', () => {
    const { sandbox, claims, logged, lockCalls } = harness({
      openRouterFields: {
        year_built: { value: '' },
        roof_age_years: { value: '19 years' },
      },
    })

    const event = fakeEvent({
      description: '5139 Alderman Rd. Concord NC 28025\nAGE OF ROOF - APPROX - 19 YRS',
    })

    const result = sandbox.syncEventToClaim(event)

    expect(result).toBe(true)
    expect(lockCalls).toHaveLength(1)

    const claim = claims.get('event-1') as Record<string, unknown>
    expect(claim.claim_number).toBe('CLF-00153289')
    expect(claim.insured_last_name).toBe('TALLEY')
    expect(claim.vendor).toBe('IBIS')
    expect(claim.address_line1).toBe('5139 Alderman Rd.')
    expect(claim.city).toBe('Concord')
    expect(claim.appt_start).toBe(new Date('2026-08-19T10:00:00Z').toISOString())
    expect(JSON.parse(claim.calendar_fields as string)).toEqual({
      roof_age_years: '19 years',
      raw_notes: '5139 Alderman Rd. Concord NC 28025\nAGE OF ROOF - APPROX - 19 YRS',
    })

    const syncedLog = logged.find((l) => l.event === 'calendar_sync.claim_synced')
    expect(syncedLog?.fields).toMatchObject({
      title: 'TALLEY - CLF-00153289 IBIS',
      claim_number: 'CLF-00153289',
    })
  })

  it('sends title, location, and description together, and stores the full 8-field response raw', () => {
    const { sandbox, claims, llmCalls } = harness({
      openRouterFields: {
        insured_name: { value: 'Talley' },
        claim_number: { value: 'CLF-00153289' },
        location: { value: '5139 Alderman Rd, Concord NC' },
        bedroom_count: { value: '' },
        bathroom_count: { value: '' },
        square_footage: { value: '' },
        year_built: { value: '' },
        roof_age_years: { value: '19 years' },
      },
    })

    const event = fakeEvent({
      location: '5139 Alderman Rd. Concord NC 28025',
      description: 'AGE OF ROOF - APPROX - 19 YRS',
    })

    const result = sandbox.syncEventToClaim(event)

    expect(result).toBe(true)
    expect(llmCalls).toHaveLength(1)
    const userMessage = llmCalls[0].messages.find((m) => m.role === 'user')
    expect(userMessage?.content).toContain('Title: TALLEY - CLF-00153289 IBIS')
    expect(userMessage?.content).toContain('Location: 5139 Alderman Rd. Concord NC 28025')
    expect(userMessage?.content).toContain('AGE OF ROOF - APPROX - 19 YRS')

    // calendar_fields carries the full response verbatim (raw), including
    // insured_name/claim_number/location even though those are also
    // independently regex-derived into their own Claims columns above.
    const claim = claims.get('event-1') as Record<string, unknown>
    expect(JSON.parse(claim.calendar_fields as string)).toEqual({
      insured_name: 'Talley',
      claim_number: 'CLF-00153289',
      location: '5139 Alderman Rd, Concord NC',
      roof_age_years: '19 years',
      raw_notes: 'AGE OF ROOF - APPROX - 19 YRS',
    })
  })

  it('tells the model the enum allowed values, and stores dwelling_stories from the calendar', () => {
    const { sandbox, claims, llmCalls } = harness({
      openRouterFields: {
        bedroom_count: { value: '4' },
        dwelling_stories: { value: '1 story' },
      },
    })

    const event = fakeEvent({
      description: '1 story - not high or steep - shingles',
    })

    sandbox.syncEventToClaim(event)

    const userMessage = llmCalls[0].messages.find((m) => m.role === 'user')
    // formatTagList is stubbed above to list tag names — the real function (see
    // prompt.test.ts) is what actually renders "allowed values: 1 story, 2
    // story, ..."; this just confirms the field list, built from enums.json's
    // real dwelling_stories/bedroom_count definitions, reaches the prompt.
    expect(userMessage?.content).toContain('Fields to extract:')
    expect(userMessage?.content).toContain('dwelling_stories')
    expect(userMessage?.content).toContain('bedroom_count')

    const claim = claims.get('event-1') as Record<string, unknown>
    expect(JSON.parse(claim.calendar_fields as string)).toEqual({
      bedroom_count: '4',
      dwelling_stories: '1 story',
      raw_notes: '1 story - not high or steep - shingles',
    })
  })

  it('stores raw_notes verbatim so nothing the model missed or mis-normalized is lost', () => {
    const { sandbox, claims } = harness({ openRouterFields: {} })

    const description =
      'DP1\nded $1k\n**ACV**\nno mortgage\nWind - All Other - damaged shingles and soft metals on roof'
    sandbox.syncEventToClaim(fakeEvent({ description }))

    const claim = claims.get('event-1') as Record<string, unknown>
    expect(JSON.parse(claim.calendar_fields as string)).toEqual({ raw_notes: description })
  })

  it('never sends an OpenRouter call for an event whose title has no claim number', () => {
    const { sandbox, llmCallCount, logged } = harness()

    sandbox.syncEventToClaim(fakeEvent({ title: 'Workout', description: 'leg day' }))

    expect(llmCallCount()).toBe(0)
    expect(logged.some((l) => l.event === 'calendar_sync.title_unparsed')).toBe(true)
  })

  it('skips the LLM call when the description is empty', () => {
    const { sandbox, llmCallCount } = harness()

    sandbox.syncEventToClaim(fakeEvent({ description: '' }))

    expect(llmCallCount()).toBe(0)
  })

  it('skips and logs when the title has no claim number', () => {
    const { sandbox, claims, logged, lockCalls } = harness()

    const result = sandbox.syncEventToClaim(fakeEvent({ title: 'Reminder: call insured' }))

    expect(result).toBe(false)
    expect(claims.size).toBe(0)
    expect(lockCalls).toHaveLength(0)
    expect(logged.some((l) => l.event === 'calendar_sync.title_unparsed')).toBe(true)
  })

  it('logs the title and error message when a single event fails instead of throwing', () => {
    const { sandbox, claims, logged } = harness({ throwOnLLM: true })

    const result = sandbox.syncEventToClaim(
      fakeEvent({
        title: 'TALLEY - CLF-1 IBIS',
        description: 'some free text describing the loss',
      }),
    )

    expect(result).toBe(false)
    expect(claims.size).toBe(0)
    const failedLog = logged.find((l) => l.event === 'calendar_sync.event_failed')
    expect(failedLog?.fields).toMatchObject({
      title: 'TALLEY - CLF-1 IBIS',
      error: 'openrouter down',
    })
  })
})

describe('property lookup in syncEventToClaim', () => {
  it('populates the property_* Claims columns from a sourced web search result', () => {
    const { sandbox, claims, webSearchCalls } = harness({
      webSearchContent: JSON.stringify({
        year_built: '1979',
        bedrooms: '3',
        bathrooms: '2',
        square_footage: '1508',
        source_url: 'https://www.city-data.com/mecklenburg-county/M/Meadow-Hollow-Drive-1.html',
      }),
    })

    const event = fakeEvent({ location: '10106 Meadow Hollow Drive Mint Hill NC 28227' })

    sandbox.syncEventToClaim(event)

    expect(webSearchCalls).toHaveLength(1)
    const userMessage = webSearchCalls[0].messages.find((m) => m.role === 'user')
    expect(userMessage?.content).toContain('10106 Meadow Hollow Drive Mint Hill NC 28227')

    const claim = claims.get('event-1') as Record<string, unknown>
    expect(claim.property_year_built).toBe('1979')
    expect(claim.property_bedrooms).toBe('3')
    expect(claim.property_bathrooms).toBe('2')
    expect(claim.property_square_footage).toBe('1508')
    expect(claim.property_source_url).toBe(
      'https://www.city-data.com/mecklenburg-county/M/Meadow-Hollow-Drive-1.html',
    )
  })

  it('leaves the property_* columns blank, and still syncs the claim, when the web search finds nothing sourced', () => {
    const { sandbox, claims } = harness({ webSearchContent: JSON.stringify({}) })

    const result = sandbox.syncEventToClaim(
      fakeEvent({ location: '218 Park Ave Wadesboro NC 28170' }),
    )

    expect(result).toBe(true)
    const claim = claims.get('event-1') as Record<string, unknown>
    expect(claim.property_year_built).toBe('')
    expect(claim.property_source_url).toBe('')
  })

  it('degrades to blank property columns, and still syncs the claim, when the web search call itself errors', () => {
    const { sandbox, claims, logged } = harness({ throwOnWebSearch: true })

    const result = sandbox.syncEventToClaim(
      fakeEvent({ location: '218 Park Ave Wadesboro NC 28170' }),
    )

    expect(result).toBe(true)
    const claim = claims.get('event-1') as Record<string, unknown>
    expect(claim.property_source_url).toBe('')
    expect(logged.some((l) => l.event === 'calendar_sync.property_lookup_failed')).toBe(true)
  })

  it('skips the web search call entirely when no address is present anywhere on the event', () => {
    const { sandbox, webSearchCalls } = harness()

    sandbox.syncEventToClaim(fakeEvent({ location: '', description: 'call to schedule' }))

    expect(webSearchCalls).toHaveLength(0)
  })
})

describe('installCalendarSync', () => {
  function triggersHarness(existingTriggers: string[] = []) {
    const properties: Record<string, string> = {}
    const created: string[] = []
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = []

    const sandbox = loadGs('apps/adjuster/src/calendarSync.js', {
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      PropertiesService: {
        getScriptProperties: () => ({
          setProperty: (key: string, value: string) => {
            properties[key] = value
          },
        }),
      },
      ScriptApp: {
        getProjectTriggers: () =>
          existingTriggers.map((handler) => ({ getHandlerFunction: () => handler })),
        newTrigger: (handlerFunction: string) => ({
          timeBased: () => ({
            everyHours: () => ({
              create: () => created.push(handlerFunction),
            }),
          }),
        }),
      },
    })

    return { sandbox, properties, created, logged }
  }

  it('sets CALENDAR_ID and installs the trigger when neither exists yet', () => {
    const { sandbox, properties, created } = triggersHarness([])

    const result = sandbox.installCalendarSync('btadjusting03@gmail.com')

    expect(properties.CALENDAR_ID).toBe('btadjusting03@gmail.com')
    expect(created).toEqual(['syncClaimsFromCalendar'])
    expect(result).toEqual({ calendar_id: 'btadjusting03@gmail.com', trigger_installed: true })
  })

  it('refuses to overwrite CALENDAR_ID with a trigger event object (a trigger misconfigured against this function)', () => {
    const { sandbox, properties } = triggersHarness([])
    const triggerEventObject = {
      hour: 18,
      'day-of-month': 22,
      minute: 19,
      triggerUid: '6146509006681669632',
    }

    expect(() => sandbox.installCalendarSync(triggerEventObject)).toThrow(/expected a calendar ID/)
    expect(properties.CALENDAR_ID).toBeUndefined()
  })

  it('refuses a non-email-shaped string just as defensively', () => {
    const { sandbox, properties } = triggersHarness([])

    expect(() => sandbox.installCalendarSync('not-a-calendar-id')).toThrow(/expected a calendar ID/)
    expect(properties.CALENDAR_ID).toBeUndefined()
  })

  it('does not install a second trigger when one already exists', () => {
    const { sandbox, created } = triggersHarness(['syncClaimsFromCalendar'])

    const result = sandbox.installCalendarSync('btadjusting03@gmail.com')

    expect(created).toEqual([])
    expect(result.trigger_installed).toBe(false)
  })
})

describe('syncClaimsFromCalendar', () => {
  it('logs and returns without syncing when the calendar cannot be found', () => {
    const claims = new Map<string, Record<string, unknown>>()
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = []

    const sandbox = loadGs('apps/adjuster/src/calendarSync.js', {
      getConfig: (key: string) => (key === 'CALENDAR_ID' ? 'missing-cal' : 'x'),
      CalendarApp: { getCalendarById: () => null },
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
      upsertClaim: (claimId: string, fields: Record<string, unknown>) =>
        claims.set(claimId, fields),
    })

    sandbox.syncClaimsFromCalendar()

    expect(claims.size).toBe(0)
    expect(logged.some((l) => l.event === 'calendar_sync.calendar_not_found')).toBe(true)
  })

  it('syncs every event in the window and tallies synced vs skipped', () => {
    const good = fakeEvent({ id: 'ev-good', title: 'TALLEY - CLF-1 IBIS' })
    const bad = fakeEvent({ id: 'ev-bad', title: 'no claim number here' })
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
    const claims = new Map<string, Record<string, unknown>>()

    const sandbox = loadGs('apps/adjuster/src/calendarSync.js', {
      getConfig: () => 'x',
      getConfigList: () => [],
      loadEnums: () => ({}),
      buildExtractionSchema: () => ({}),
      callOpenRouter: () => ({ fields: {} }),
      withJobLock: (fn: () => unknown) => fn(),
      upsertClaim: (claimId: string, fields: Record<string, unknown>) =>
        claims.set(claimId, fields),
      ensureClaimsColumns: () => [],
      describeError: (err: Error) => ({ error: String(err.message || err), stack: '' }),
      CalendarApp: { getCalendarById: () => ({ getEvents: () => [good, bad] }) },
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    })

    sandbox.syncClaimsFromCalendar()

    expect(claims.has('ev-good')).toBe(true)
    expect(claims.has('ev-bad')).toBe(false)
    const tickEnd = logged.find((l) => l.event === 'calendar_sync.tick_end')
    expect(tickEnd?.fields).toMatchObject({
      synced: 1,
      skipped: 1,
      synced_titles: 'TALLEY - CLF-1 IBIS',
      skipped_titles: 'no claim number here',
    })
  })

  it('logs tick_failed and rethrows when the calendar API itself fails', () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = []

    const sandbox = loadGs('apps/adjuster/src/calendarSync.js', {
      getConfig: () => 'calendar-1',
      describeError: (err: Error) => ({ error: String(err.message || err), stack: '' }),
      ensureClaimsColumns: () => [],
      CalendarApp: {
        getCalendarById: () => ({
          getEvents: () => {
            throw new Error('Calendar service unavailable')
          },
        }),
      },
      logEvent: (event: string, fields: Record<string, unknown>) => logged.push({ event, fields }),
    })

    expect(() => sandbox.syncClaimsFromCalendar()).toThrow('Calendar service unavailable')
    expect(logged.some((l) => l.event === 'calendar_sync.tick_failed')).toBe(true)
  })
})
