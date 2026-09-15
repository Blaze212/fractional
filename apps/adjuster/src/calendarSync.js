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
  // docs/specs/027. Appended, never inserted: ensureClaimsColumns adds missing
  // headers at the end and every reader goes through getSheetRows' header map,
  // so a Claims row written before these existed still reads (its blank
  // fingerprints simply mean "enrich once, then cache").
  'calendar_fingerprint',
  'property_address_fingerprint',
  'property_lookup_at',
]

// A property lookup that ran and genuinely found nothing is cached this long.
// Without a negative cache an unresolvable address is re-searched every hour
// forever, which is the same defect in miniature; bounded so an address that
// becomes findable is not hidden indefinitely. A corrected address changes the
// fingerprint and re-runs immediately regardless.
var PROPERTY_LOOKUP_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

    // ONE Sheet read per tick, mapped by claim_id, rather than one per event:
    // every event's enrichment-cache check is answered out of this map.
    var storedClaims = indexClaimsByCalendarId(getClaims())

    var syncedTitles = []
    var skippedTitles = []
    var llmCalls = 0
    var llmCallsSkipped = 0

    events.forEach(function (event) {
      var outcome = syncEventToClaim(event, storedClaims[event.getId()] || null)

      llmCalls += outcome.llm_calls
      llmCallsSkipped += outcome.llm_calls_skipped

      if (outcome.synced) {
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
    // llm_calls / llm_calls_skipped are the cost line: on a steady calendar the
    // second tick over the same events should read llm_calls: 0.
    logEvent('calendar_sync.tick_end', {
      synced: syncedTitles.length,
      skipped: skippedTitles.length,
      synced_titles: syncedTitles.join(' | '),
      skipped_titles: skippedTitles.join(' | '),
      llm_calls: llmCalls,
      llm_calls_skipped: llmCallsSkipped,
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

// storedClaim is this event's Claims row as the tick read it, or null when the
// event has never synced. It is what makes the enrichment cache possible: both
// paid calls are gated on shouldReenrich comparing it against the event's
// current fingerprints. The non-LLM fields below are rewritten every tick
// regardless — they cost nothing and keep the row honest about the invite.
//
// Returns the per-event tally the tick summarises, not a bare boolean, so
// calendar_sync.tick_end can report how many calls this tick made and how many
// the cache saved.
function syncEventToClaim(event, storedClaim) {
  var eventId = event.getId()

  try {
    var header = parseEventTitle(event.getTitle())
    if (!header.claim_number) {
      logEvent('calendar_sync.title_unparsed', { event_id: eventId, title: event.getTitle() })
      return eventOutcome(false, 0, 0)
    }

    var description = event.getDescription() || ''
    var address = parseAddress(event.getLocation(), description)
    var fullAddressText = resolveFullAddressText(event.getLocation(), description)

    var fingerprints = calendarEnrichmentFingerprints(
      event.getTitle(),
      event.getLocation(),
      description,
      fullAddressText,
    )
    var decision = shouldReenrich(storedClaim || null, fingerprints, new Date())

    // extractCalendarFields and lookupPropertyDetailsSafely each already skip
    // their call when their own input is empty, so a decision to run is only a
    // real call when there is something to run it on. Counted here rather than
    // inside them so the tally matches what OpenRouter is actually billed for.
    var extractable = description.trim() !== ''
    var lookupable = fullAddressText !== ''

    var details = decision.extract
      ? extractCalendarFields(event.getTitle(), event.getLocation(), description)
      : { fields: storedCalendarFields(storedClaim) }

    var propertyLookup = decision.lookup
      ? lookupPropertyDetailsSafely(fullAddressText)
      : { values: storedPropertyValues(storedClaim), failed: false }

    // The LLM's extracted fields are a lossy summary — keep the verbatim
    // description alongside them so nothing the model missed or mis-normalized
    // is ever unrecoverable from the Claims row itself.
    var calendarFields = Object.assign({}, details.fields)
    if (description) calendarFields.raw_notes = description

    var propertyValues = resolvePropertyValues(storedClaim, decision, propertyLookup)

    var fields = {
      insured_last_name: header.insured_last_name,
      claim_number: header.claim_number,
      vendor: header.vendor,
      address_line1: address.address_line1,
      city: address.city,
      appt_start: event.getStartTime().toISOString(),
      appt_end: event.getEndTime().toISOString(),
      calendar_fields: JSON.stringify(calendarFields),
      property_year_built: propertyValues.year_built,
      property_bedrooms: propertyValues.bedrooms,
      property_bathrooms: propertyValues.bathrooms,
      property_square_footage: propertyValues.square_footage,
      property_source_url: propertyValues.source_url,
      calendar_fingerprint: fingerprints.calendar_fingerprint,
      property_address_fingerprint: fingerprints.property_address_fingerprint,
      property_lookup_at: resolvePropertyLookupAt(storedClaim, decision, propertyLookup),
    }

    withJobLock(function () {
      upsertClaim(eventId, fields)
    })

    var calls = (decision.extract && extractable ? 1 : 0) + (decision.lookup && lookupable ? 1 : 0)
    var skipped =
      (!decision.extract && extractable ? 1 : 0) + (!decision.lookup && lookupable ? 1 : 0)

    if (skipped > 0) {
      logEvent('calendar_sync.enrichment_skipped', {
        event_id: eventId,
        title: event.getTitle(),
        extract_skipped: !decision.extract,
        lookup_skipped: !decision.lookup,
      })
    }

    logEvent('calendar_sync.claim_synced', {
      event_id: eventId,
      title: event.getTitle(),
      claim_number: header.claim_number,
      field_count: Object.keys(details.fields).length,
      llm_calls: calls,
      llm_calls_skipped: skipped,
    })

    return eventOutcome(true, calls, skipped)
  } catch (err) {
    var described = describeError(err)
    logEvent('calendar_sync.event_failed', {
      event_id: eventId,
      title: event.getTitle(),
      error: described.error,
      stack: described.stack,
    })
    return eventOutcome(false, 0, 0)
  }
}

// upsertClaim files a calendar-sourced claim under the event id, so claim_id IS
// the event id for every row this sync writes. Rows from any other source simply
// never match an event and are ignored.
function indexClaimsByCalendarId(claims) {
  var byId = {}

  ;(claims || []).forEach(function (claim) {
    if (claim && claim.claim_id) byId[claim.claim_id] = claim
  })

  return byId
}

function eventOutcome(synced, calls, skipped) {
  return { synced: synced, llm_calls: calls, llm_calls_skipped: skipped }
}

// The stored calendar_fields cell is the previous tick's extraction plus the
// verbatim raw_notes added above; raw_notes is stripped back off so a cached
// tick rebuilds the cell from the event's own description rather than carrying
// a stale copy of it forward.
function storedCalendarFields(storedClaim) {
  if (!storedClaim || !storedClaim.calendar_fields) return {}

  var parsed
  try {
    parsed = JSON.parse(storedClaim.calendar_fields)
  } catch (err) {
    return {}
  }

  if (!parsed || typeof parsed !== 'object') return {}

  delete parsed.raw_notes
  return parsed
}

function storedPropertyValues(storedClaim) {
  if (!storedClaim) return EMPTY_PROPERTY_LOOKUP

  return {
    year_built: String(storedClaim.property_year_built || ''),
    bedrooms: String(storedClaim.property_bedrooms || ''),
    bathrooms: String(storedClaim.property_bathrooms || ''),
    square_footage: String(storedClaim.property_square_footage || ''),
    source_url: String(storedClaim.property_source_url || ''),
  }
}

// A lookup that threw tells us nothing about the property, so the row keeps
// whatever it already held rather than being blanked and re-searched next tick —
// unless the address itself changed, in which case the stored values describe a
// different house and must go.
function resolvePropertyValues(storedClaim, decision, propertyLookup) {
  if (!decision.lookup) return propertyLookup.values
  if (!propertyLookup.failed) return propertyLookup.values
  return decision.address_changed ? EMPTY_PROPERTY_LOOKUP : storedPropertyValues(storedClaim)
}

// The cache marker: set when a lookup completed (found or genuinely empty),
// cleared when one threw so the next tick retries it. Never carried forward
// across an address change — that marker belongs to the old address.
function resolvePropertyLookupAt(storedClaim, decision, propertyLookup) {
  if (!decision.lookup) return String((storedClaim && storedClaim.property_lookup_at) || '')
  if (propertyLookup.failed) return ''
  return new Date().toISOString()
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

// docs/specs/027. Both enrichment calls are pure functions of text that lives on
// the calendar event, so a tick can decide whether either needs to run at all by
// comparing a fingerprint of those inputs against the one stored on the Claims
// row. Before this, the 52-hour window and the hourly trigger meant every event
// was re-enriched about forty times before it aged out — 278 property lookups
// across 10 distinct events in 48 hours, re-searching houses whose year built
// and square footage were already sitting on the row.
//
// Fingerprints are only ever compared, never inspected, so any cheap hash will
// do — but a collision would silently suppress an enrichment that should have
// run, so this pairs two independent 32-bit hashes with the input length.
function fingerprintText(text) {
  var value = String(text == null ? '' : text)
  var djb2 = 5381
  var sdbm = 0

  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i)
    djb2 = (djb2 * 33 + code) | 0
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) | 0
  }

  return value.length + '-' + toHex32(djb2) + toHex32(sdbm)
}

function toHex32(n) {
  return ('0000000' + (n >>> 0).toString(16)).slice(-8)
}

// \u0000 rather than a printable separator: it cannot occur in a calendar field,
// so no rearrangement of title/location/description can produce the same joined
// string as a different one.
function calendarFieldsFingerprint(title, location, description) {
  return fingerprintText([title || '', location || '', description || ''].join('\u0000'))
}

// The lookup receives exactly this string (see resolveFullAddressText), so it is
// the whole input and the whole fingerprint.
function propertyAddressFingerprint(fullAddressText) {
  return fingerprintText(fullAddressText || '')
}

function calendarEnrichmentFingerprints(title, location, description, fullAddressText) {
  return {
    calendar_fingerprint: calendarFieldsFingerprint(title, location, description),
    property_address_fingerprint: propertyAddressFingerprint(fullAddressText),
  }
}

// Decides which of the two paid calls this tick needs, given the Claims row as
// it stands (stored, or null for an event never synced), the event's current
// fingerprints, and the current time.
//
// The property lookup has three outcomes and they cache differently:
//   found  — property_source_url is set. Cached until the address changes.
//   miss   — the call returned nothing sourced. property_lookup_at marks it;
//            cached for PROPERTY_LOOKUP_MISS_TTL_MS so an unresolvable address
//            is not re-searched hourly forever.
//   failed — the call threw. No marker is written, so this returns true and the
//            next tick retries. Caching a 402 as a miss would suppress the
//            lookup for a week after credits were restored.
function shouldReenrich(stored, current, now) {
  if (!stored) {
    return { extract: true, lookup: true, address_changed: true }
  }

  var addressChanged =
    String(stored.property_address_fingerprint || '') !== current.property_address_fingerprint

  return {
    extract: String(stored.calendar_fingerprint || '') !== current.calendar_fingerprint,
    lookup: addressChanged || propertyLookupCacheExpired(stored, now),
    address_changed: addressChanged,
  }
}

function propertyLookupCacheExpired(stored, now) {
  if (stored.property_source_url) return false

  var lookupAt = Date.parse(String(stored.property_lookup_at || ''))
  if (isNaN(lookupAt)) return true

  return now.getTime() - lookupAt >= PROPERTY_LOOKUP_MISS_TTL_MS
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
//
// Returns { values, failed } rather than the bare values because the caller has
// to tell "searched, found nothing" from "the call never completed": the first
// is cached, the second must be retried. Collapsing both into
// EMPTY_PROPERTY_LOOKUP would have cached a 402 as a miss and suppressed the
// lookup for a week after credits were restored (docs/specs/027).
function lookupPropertyDetailsSafely(fullAddressText) {
  // No address is not a failure — there is nothing to look up, and the empty
  // address fingerprint re-runs this the moment one appears on the event.
  if (!fullAddressText) return { values: EMPTY_PROPERTY_LOOKUP, failed: false }

  try {
    return { values: lookupPropertyDetails(fullAddressText), failed: false }
  } catch (err) {
    var described = describeError(err)
    logEvent('calendar_sync.property_lookup_failed', {
      address: fullAddressText,
      error: described.error,
    })
    return { values: EMPTY_PROPERTY_LOOKUP, failed: true }
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
