var CALENDAR_SYNC_WINDOW_PAST_HOURS = 4
var CALENDAR_SYNC_WINDOW_FUTURE_HOURS = 48

// "carrier" is a pre-existing Claims column calendar sync never writes to —
// the third title token ("...CLF-00153289    IBIS") is the scheduling
// vendor, not the insurance carrier, which (when stated at all) only ever
// shows up in the free-text description. See parseEventTitle.
var CLAIMS_CALENDAR_COLUMNS = [
  'claim_id',
  'appt_start',
  'appt_end',
  'insured_last_name',
  'address_line1',
  'city',
  'claim_number',
  'vendor',
  'calendar_fields',
  'property_year_built',
  'property_bedrooms',
  'property_bathrooms',
  'property_square_footage',
  'property_source_url',
]

// "5139 Alderman Rd. Concord NC 28025" and "1104 S Zion St, Landis, NC 28088"
// both need to parse -> street / city / state / zip. The street/city split
// point is anchored on the street-suffix word (same suffix list matcher.js
// normalizes against) rather than the comma, since real invites are
// inconsistent about whether one is there at all: everything up to and
// including the suffix is the street, everything between it and the state
// code is the city. [,\s]+ (not \s+) between street and city because a comma
// can sit directly against the suffix with no space before it ("St, Landis").
// Assumes a two-letter state code and a US zip — the only format seen so far.
var STREET_SUFFIXES =
  'street|avenue|boulevard|drive|road|lane|court|place|terrace|circle|parkway|highway|st|ave|blvd|dr|rd|ln|ct|pl|ter|cir|pkwy|hwy|way'

var US_STREET_ADDRESS_PATTERN = new RegExp(
  '^(\\d+\\s+.+?\\b(?:' +
    STREET_SUFFIXES +
    ')\\b\\.?)[,\\s]+(.+?),?\\s+([A-Za-z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\s*$',
  'i',
)

// bedroom_count/bathroom_count/square_footage/year_built/roof_age_years/
// dwelling_stories match enums.json's tag names exactly on purpose — runner.js
// merges this object straight into liveExtraction, and prompt.js's
// formatLiveExtraction only surfaces keys that match a templateSpec
// (enums.json) tag, so these flow into the final extraction call with no
// separate mapping step. Pulling their real definitions out of enums.json
// (rather than a bare {} placeholder) means the calendar-extraction prompt
// carries whatever label and allowed-values list enums.json defines for each
// tag, so this prompt cannot drift from the one the transcript extraction
// gets via prompt.js's formatTagList. None of these are closed enums any
// more — bedroom_count and bathroom_count were loosened to strings so a real
// answer ("2.5" bathrooms, a 7-bedroom house) is never rejected by an
// artificially narrow list and silently left NEEDS INPUT.
// insured_name/claim_number/location are not
// template tags and don't surface via liveExtraction, but ride along as raw,
// undeduped context (identity is already covered by the Claims row itself via
// formatClaimBlock).
var CALENDAR_PROPERTY_TAG_NAMES = [
  'bedroom_count',
  'bathroom_count',
  'square_footage',
  'year_built',
  'roof_age_years',
  'dwelling_stories',
]

var CALENDAR_IDENTITY_TAGS = {
  insured_name: { type: 'string', label: 'Insured name' },
  claim_number: { type: 'string', label: 'Claim number' },
  location: { type: 'string', label: 'Property address' },
}

function buildCalendarTagSchema() {
  var enums = loadEnums()
  var schema = Object.assign({}, CALENDAR_IDENTITY_TAGS)

  CALENDAR_PROPERTY_TAG_NAMES.forEach(function (tag) {
    if (enums[tag]) schema[tag] = enums[tag]
  })

  return schema
}

var CALENDAR_EXTRACTION_SYSTEM_PROMPT = [
  "You are extracting claim and property details from an insurance scheduler's",
  'calendar entry for an inspection appointment. The entry is informal',
  'shorthand, not a form — a title, a location, and a free-text description.',
  'Extract only what it actually states. For every field not mentioned, return',
  'an empty string as its value — never guess or infer a value the entry does',
  'not support. For enum fields, value must be exactly one of the listed',
  "allowed values, character for character — normalize the entry's wording to",
  'the closest matching allowed value only when the entry clearly supports it',
  '(e.g. "four" normalizes to "4"); if nothing reasonably maps to any allowed',
  'value, return the field empty instead of forcing a bad fit.',
].join(' ')

// Kept deliberately separate from CALENDAR_PROPERTY_TAG_NAMES/
// buildCalendarTagSchema above: those feed straight into the report via
// runner.js's liveExtraction merge, but a live web search is far less
// reliable than a fact the adjuster actually typed into the calendar invite
// (spot-check against 10 real production addresses found only ~3 of 10
// resolved to a real, sourced answer at all). This writes to its own Claims
// columns, and validate.js's applyClaimPropertyFallback reads them back into
// the report only as a last resort, after both the transcript and
// calendar_fields came up empty — property_source_url is on the Claims row
// beside them so the adjuster can check any value that reached a draft
// this way.
var PROPERTY_LOOKUP_SYSTEM_PROMPT = [
  'You are looking up public real estate records for a specific US property',
  'address using web search. Report only facts you can point to on a real',
  'page you found — never guess, estimate, or infer a value. If you cannot',
  'find a page that explicitly states a field, leave that field as an empty',
  'string. Respond with ONLY a JSON object, no other text, in this exact',
  'shape: {"year_built":"","bedrooms":"","bathrooms":"","square_footage":"",',
  '"source_url":""}. source_url must be the exact URL of the single page the',
  'other fields came from. If source_url is empty, every other field must',
  'also be empty — never report a fact without the page it came from.',
].join(' ')

// One-time (idempotent) setup: point sync at a calendar and install its
// trigger. Safe to re-run — it never creates a second trigger for the same
// handler, and re-setting CALENDAR_ID to the same value is a no-op.
//
// This takes a parameter, which makes it a trap for Apps Script's own time
// trigger UI: pointing an hourly trigger at this function by mistake (instead
// of the zero-arg syncClaimsFromCalendar or runInstallCalendarSync below)
// makes Apps Script call it with the trigger's event object as calendarId —
// PropertiesService.setProperty stringifies whatever it's given, so that
// silently overwrites CALENDAR_ID with something like
// "{hour=18.0, day-of-month=22.0, ...}" every time the trigger fires, and
// every subsequent sync tick fails with calendar_not_found until someone
// notices. The validation below turns that into a loud failure on the
// offending trigger's own execution instead.
function installCalendarSync(calendarId) {
  if (typeof calendarId !== 'string' || calendarId.indexOf('@') === -1) {
    throw new Error(
      'installCalendarSync expected a calendar ID (e.g. "name@gmail.com") but got: ' +
        String(calendarId) +
        ' — refusing to overwrite CALENDAR_ID. If this ran from a trigger, that trigger is ' +
        'pointed at installCalendarSync instead of syncClaimsFromCalendar; delete it.',
    )
  }

  PropertiesService.getScriptProperties().setProperty('CALENDAR_ID', calendarId)

  var alreadyInstalled = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'syncClaimsFromCalendar'
  })

  if (!alreadyInstalled) {
    ScriptApp.newTrigger('syncClaimsFromCalendar').timeBased().everyHours(1).create()
  }

  logEvent('calendar_sync.install', {
    calendar_id: calendarId,
    trigger_installed: !alreadyInstalled,
  })

  return { calendar_id: calendarId, trigger_installed: !alreadyInstalled }
}

// The editor's plain Run button can't pass arguments — this is the zero-arg
// entry point to select and run once from the Apps Script editor. Safe to
// leave in place; re-running it is a no-op once the trigger already exists.
function runInstallCalendarSync() {
  return installCalendarSync('btadjusting03@gmail.com')
}

// Runs on the hourly trigger installCalendarSync installs. Every request
// produces one tick_start/tick_end pair, or a tick_failed if the calendar itself can't be
// read (network error, revoked share access, bad CALENDAR_ID). A single bad
// event within a successful fetch is logged and skipped rather than failing the
// whole run, since one malformed invite should not block the rest of the day's
// claims from syncing — but a failure to reach the calendar at all fails loudly
// (and rethrows, matching runPipelineTick) so a broken sync doesn't fail silent
// and leave claims stale with no signal anywhere.
function syncClaimsFromCalendar() {
  var startedAt = Date.now()

  try {
    var calendarId = getConfig('CALENDAR_ID')
    var calendar = CalendarApp.getCalendarById(calendarId)

    if (!calendar) {
      logEvent('calendar_sync.calendar_not_found', { calendar_id: calendarId })
      return
    }

    var addedColumns = ensureClaimsColumns(CLAIMS_CALENDAR_COLUMNS)
    if (addedColumns.length > 0) {
      logEvent('calendar_sync.claims_columns_added', { columns: addedColumns.join(',') })
    }

    var now = new Date()
    var windowStart = new Date(now.getTime() - CALENDAR_SYNC_WINDOW_PAST_HOURS * 60 * 60 * 1000)
    var windowEnd = new Date(now.getTime() + CALENDAR_SYNC_WINDOW_FUTURE_HOURS * 60 * 60 * 1000)
    var events = calendar.getEvents(windowStart, windowEnd)

    logEvent('calendar_sync.tick_start', { event_count: events.length })

    var syncedTitles = []
    var skippedTitles = []

    events.forEach(function (event) {
      if (syncEventToClaim(event)) {
        syncedTitles.push(event.getTitle())
      } else {
        skippedTitles.push(event.getTitle())
      }
    })

    // Keeps webhook.js's pre-call claim-suggestion cache warm — see spec 015
    // and jobs.js's refreshClaimCandidatesCache(). Own try/catch so a
    // CacheService hiccup degrades to "no cache refresh this tick" the same
    // way every other best-effort piece of this tick already does, rather
    // than failing the sync or skipping the tick_end log below.
    try {
      refreshClaimCandidatesCache()
    } catch (err) {
      logEvent('calendar_sync.cache_refresh_failed', { error: String(err) })
    }

    // One glance-able summary line per tick, on top of the per-event
    // claim_synced/event_failed/title_unparsed lines below — synced_titles and
    // skipped_titles so a bad sync is visible from the Raw sheet without having
    // to cross-reference event IDs against the calendar.
    logEvent('calendar_sync.tick_end', {
      synced: syncedTitles.length,
      skipped: skippedTitles.length,
      synced_titles: syncedTitles.join(' | '),
      skipped_titles: skippedTitles.join(' | '),
      ms: Date.now() - startedAt,
    })
  } catch (err) {
    var described = describeError(err)
    logEvent('calendar_sync.tick_failed', {
      error: described.error,
      stack: described.stack,
      ms: Date.now() - startedAt,
    })
    throw err
  }
}

function syncEventToClaim(event) {
  var eventId = event.getId()

  try {
    var header = parseEventTitle(event.getTitle())
    if (!header.claim_number) {
      logEvent('calendar_sync.title_unparsed', { event_id: eventId, title: event.getTitle() })
      return false
    }

    var description = event.getDescription() || ''
    var address = parseAddress(event.getLocation(), description)
    var details = extractCalendarFields(event.getTitle(), event.getLocation(), description)
    var propertyLookup = lookupPropertyDetailsSafely(
      resolveFullAddressText(event.getLocation(), description),
    )

    // The LLM's extracted fields are a lossy summary — keep the verbatim
    // description alongside them so nothing the model missed or mis-normalized
    // is ever unrecoverable from the Claims row itself.
    var calendarFields = Object.assign({}, details.fields)
    if (description) calendarFields.raw_notes = description

    var fields = {
      insured_last_name: header.insured_last_name,
      claim_number: header.claim_number,
      vendor: header.vendor,
      address_line1: address.address_line1,
      city: address.city,
      appt_start: event.getStartTime().toISOString(),
      appt_end: event.getEndTime().toISOString(),
      calendar_fields: JSON.stringify(calendarFields),
      property_year_built: propertyLookup.year_built,
      property_bedrooms: propertyLookup.bedrooms,
      property_bathrooms: propertyLookup.bathrooms,
      property_square_footage: propertyLookup.square_footage,
      property_source_url: propertyLookup.source_url,
    }

    withJobLock(function () {
      upsertClaim(eventId, fields)
    })

    logEvent('calendar_sync.claim_synced', {
      event_id: eventId,
      title: event.getTitle(),
      claim_number: header.claim_number,
      field_count: Object.keys(details.fields).length,
    })

    return true
  } catch (err) {
    var described = describeError(err)
    logEvent('calendar_sync.event_failed', {
      event_id: eventId,
      title: event.getTitle(),
      error: described.error,
      stack: described.stack,
    })
    return false
  }
}

// "TALLEY - CLF-00153289    IBIS" -> last name, claim number, vendor. The
// third token is the scheduling vendor (e.g. "IBIS"), not the insurance
// carrier — the same vendor name recurs across claims for entirely different
// insureds and carriers, which a real carrier name never would. The separator
// must have surrounding whitespace so a claim number's own internal hyphen
// (CLF-00153289) never gets mistaken for the split point.
function parseEventTitle(title) {
  var match = /^(.+?)\s+-\s+(\S+)(?:\s+(.+))?$/.exec((title || '').trim())
  if (!match) return { insured_last_name: '', claim_number: '', vendor: '' }

  return {
    insured_last_name: match[1].trim(),
    claim_number: match[2].trim(),
    vendor: (match[3] || '').trim(),
  }
}

// Prefers the event's native Location field; falls back to the first non-blank
// line of the description, since some invites carry the address there instead.
function parseAddress(location, description) {
  var candidates = [location, firstLine(description)]

  for (var i = 0; i < candidates.length; i++) {
    var parsed = matchAddress(candidates[i])
    if (parsed) return parsed
  }

  return { address_line1: '', city: '' }
}

function firstLine(text) {
  var lines = (text || '').split('\n')
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim()
    if (trimmed) return trimmed
  }
  return ''
}

function matchAddress(text) {
  var match = US_STREET_ADDRESS_PATTERN.exec((text || '').trim())
  if (!match) return null
  return { address_line1: match[1].trim(), city: match[2].trim() }
}

// The description is unstructured shorthand — policy notes, contractor contact,
// property details, adjuster commentary — with no fixed layout, so an LLM pass
// extracts it into buildCalendarTagSchema()'s tags. Description alone rarely
// repeats the title/location fields, but passing all three gives the model the
// full context to corroborate them where it can. Skips the call entirely when
// the description is empty, since square footage/bed/bath/roof age/stories
// never show up in the title or location alone and the call would just return
// all-empty.
function extractCalendarFields(title, location, description) {
  if (!description.trim()) return { fields: {} }

  var tagSchema = buildCalendarTagSchema()
  var content = [
    'Title: ' + (title || ''),
    'Location: ' + (location || ''),
    'Description:',
    description,
    '',
    'Fields to extract:',
    formatTagList(tagSchema),
  ].join('\n')

  var response = callOpenRouter({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENROUTER_MODEL'),
    fallbacks: getConfigList('OPENROUTER_FALLBACKS', []),
    messages: [
      { role: 'system', content: CALENDAR_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: content },
    ],
    jsonSchema: buildExtractionSchema(tagSchema),
  })

  var flat = {}
  Object.keys(response.fields || {}).forEach(function (tag) {
    var entry = response.fields[tag]
    if (entry && entry.value) flat[tag] = entry.value
  })

  return { fields: flat }
}

// parseAddress above keeps only street/city for the Claims columns, throwing
// away the state/zip capture groups matchAddress already parsed — a web
// search needs the full "street, city, state zip" text to disambiguate
// (plenty of street names repeat across cities/states). Re-runs the same
// candidate/match logic to recover the original matched text instead of the
// split-apart parts.
function resolveFullAddressText(location, description) {
  var candidates = [location, firstLine(description)]

  for (var i = 0; i < candidates.length; i++) {
    if (matchAddress(candidates[i])) return stripZipPlusFour(candidates[i].trim())
  }

  return ''
}

// Zillow/Redfin (the sites the web search is actually trying to hit) index by
// the plain 5-digit ZIP — including the +4 extension in the query narrows the
// search enough that the real listing often drops out of the results
// entirely. US_STREET_ADDRESS_PATTERN's zip group anchors on \s*$, so the
// +4 (if present) is always the last thing in the trimmed string.
function stripZipPlusFour(text) {
  return text.replace(/(\d{5})-\d{4}\s*$/, '$1')
}

var EMPTY_PROPERTY_LOOKUP = {
  year_built: '',
  bedrooms: '',
  bathrooms: '',
  square_footage: '',
  source_url: '',
}

// Wraps lookupPropertyDetails so a bad address, an OpenRouter/OpenAI outage,
// or a malformed response degrades to "nothing found" instead of failing the
// whole claim sync — this is best-effort enrichment on top of a sync that
// already succeeded without it.
function lookupPropertyDetailsSafely(fullAddressText) {
  if (!fullAddressText) return EMPTY_PROPERTY_LOOKUP

  try {
    return lookupPropertyDetails(fullAddressText)
  } catch (err) {
    var described = describeError(err)
    logEvent('calendar_sync.property_lookup_failed', {
      address: fullAddressText,
      error: described.error,
    })
    return EMPTY_PROPERTY_LOOKUP
  }
}

function lookupPropertyDetails(fullAddressText) {
  var response = callOpenRouterWebSearch({
    apiKey: getConfig('OPENROUTER_API_KEY'),
    model: getConfig('OPENAI_WEB_SEARCH_MODEL'),
    messages: [
      { role: 'system', content: PROPERTY_LOOKUP_SYSTEM_PROMPT },
      { role: 'user', content: 'Property address: ' + fullAddressText },
    ],
  })

  return parsePropertyLookupResponse(response.content)
}

// Guards against the failure mode seen in testing: a search-engine summary
// can assert specific-looking bed/bath/sqft numbers for an address with no
// real matching page behind them at all. Trusting a value only when it's
// bundled with the exact page it came from doesn't catch every case, but it
// catches the fabricated-with-zero-source one that testing actually produced.
function parsePropertyLookupResponse(content) {
  var text = String(content || '').trim()

  // Models sometimes wrap JSON in a ```json fence despite instructions not to.
  var fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text)
  if (fenceMatch) text = fenceMatch[1].trim()

  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return EMPTY_PROPERTY_LOOKUP
  }

  if (!parsed || !parsed.source_url) return EMPTY_PROPERTY_LOOKUP

  return {
    year_built: String(parsed.year_built || ''),
    bedrooms: String(parsed.bedrooms || ''),
    bathrooms: String(parsed.bathrooms || ''),
    square_footage: String(parsed.square_footage || ''),
    source_url: String(parsed.source_url || ''),
  }
}
