import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error standalone zero-dependency script, no type declarations
import {
  aggregateBySource,
  extractGlossaryTerms,
  findExpectedTerms,
  loadManifest,
  normalizeForMatch,
  rankSources,
  renderMarkdownReport,
  scoreCall,
  scoreCalls,
  scoreTranscript,
  termOccursIn,
} from '../../scripts/adjuster-asr-eval.mjs'

const GLOSSARY = [
  { term: 'ridge', definition: 'the horizontal peak where two roof slopes meet' },
  { term: 'ridge cap', definition: 'shingles or metal covering installed over the ridge' },
  { term: 'drip edge', definition: 'metal flashing installed along roof edges' },
  { term: '3-tab shingle', definition: 'a flat, single-layer asphalt shingle style' },
  { term: 'RCV', definition: 'replacement cost value' },
]
const GLOSSARY_TERMS = extractGlossaryTerms(GLOSSARY)

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeForMatch('Drip-Edge,   installed!')).toBe('drip edge installed')
  })

  it('collapses hyphens to spaces so hyphenated and spaced variants match', () => {
    expect(normalizeForMatch('3-Tab Shingle')).toBe('3 tab shingle')
    expect(normalizeForMatch('3 Tab Shingle')).toBe('3 tab shingle')
  })
})

describe('extractGlossaryTerms', () => {
  it('pulls the flat term list off a parsed glossary array', () => {
    expect(extractGlossaryTerms(GLOSSARY)).toEqual([
      'ridge',
      'ridge cap',
      'drip edge',
      '3-tab shingle',
      'RCV',
    ])
  })
})

describe('termOccursIn', () => {
  it('matches a term present in the transcript, case/punctuation-insensitive', () => {
    expect(termOccursIn('drip edge', 'The Drip-Edge was missing.')).toBe(true)
  })

  it('does not match a term that is only a substring of another word', () => {
    expect(termOccursIn('ridge', 'the fridge was fine')).toBe(false)
  })

  it('matches a multi-word term as a phrase, not word-order-independent', () => {
    expect(termOccursIn('ridge cap', 'we replaced the ridge cap')).toBe(true)
    expect(termOccursIn('ridge cap', 'the cap on the ridge')).toBe(false)
  })

  it('matches a hyphenated numeric term', () => {
    expect(termOccursIn('3-tab shingle', 'it uses a 3-tab shingle')).toBe(true)
  })

  it('returns false for an empty term', () => {
    expect(termOccursIn('', 'anything at all')).toBe(false)
  })
})

describe('findExpectedTerms', () => {
  it('narrows glossary + proper nouns to only what appears in the reference', () => {
    // "ridge" is also present as a standalone word inside "ridge cap" — both
    // terms legitimately match; see the Edge Cases table in the spec for why
    // this overlap is expected behavior, not a bug.
    const expected = findExpectedTerms({
      referenceText:
        'We found a drip edge issue and replaced the ridge cap. Insured is Dana Whitfield.',
      glossaryTerms: GLOSSARY_TERMS,
      properNouns: ['Dana Whitfield', 'Meridian Mutual'],
    })
    expect(expected).toEqual(['ridge', 'ridge cap', 'drip edge', 'Dana Whitfield'])
  })

  it('returns an empty array when nothing in the reference matches', () => {
    expect(
      findExpectedTerms({
        referenceText: 'Nothing relevant was said here.',
        glossaryTerms: GLOSSARY_TERMS,
        properNouns: [],
      }),
    ).toEqual([])
  })

  it('deduplicates terms that normalize the same', () => {
    const expected = findExpectedTerms({
      referenceText: 'RCV came up twice: RCV and rcv.',
      glossaryTerms: GLOSSARY_TERMS,
      properNouns: ['RCV'],
    })
    expect(expected).toEqual(['RCV'])
  })
})

describe('scoreTranscript', () => {
  it('reports matched and missed terms with accuracy', () => {
    const result = scoreTranscript({
      transcriptText: 'We found a drip edge issue.',
      expectedTerms: ['drip edge', 'ridge cap'],
    })
    expect(result.matched).toEqual(['drip edge'])
    expect(result.missed).toEqual(['ridge cap'])
    expect(result.accuracy).toBeCloseTo(0.5, 6)
  })

  it('scores 1 when there are no expected terms', () => {
    expect(scoreTranscript({ transcriptText: 'anything', expectedTerms: [] }).accuracy).toBe(1)
  })

  it('scores 0 when nothing expected is present', () => {
    const result = scoreTranscript({
      transcriptText: 'totally unrelated text',
      expectedTerms: ['drip edge'],
    })
    expect(result.accuracy).toBe(0)
  })
})

describe('scoreCall / scoreCalls', () => {
  const call = {
    callId: 'call-001',
    referenceText: 'We found a drip edge issue and replaced the ridge cap for Dana Whitfield.',
    properNouns: ['Dana Whitfield'],
    sources: {
      retell: 'We found a drip edge issue and replaced the ridge cap for Dana Whitfield.',
      elevenlabs: 'We found a drip-edge issue and replaced the ridge cap for Dan Whitfield.',
      qwen: 'We found a trip edge issue and replaced the ridge cap for Dana Whitfield.',
    },
  }

  it('scores each source against the terms found in the reference', () => {
    const result = scoreCall(call, GLOSSARY_TERMS)
    expect(result.expectedTerms).toEqual(['ridge', 'ridge cap', 'drip edge', 'Dana Whitfield'])
    expect(result.sources.retell.accuracy).toBe(1)
    expect(result.sources.elevenlabs.missed).toEqual(['Dana Whitfield'])
    expect(result.sources.qwen.missed).toEqual(['drip edge'])
  })

  it('scoreCalls maps scoreCall over every manifest entry', () => {
    const results = scoreCalls([call], GLOSSARY_TERMS)
    expect(results).toHaveLength(1)
    expect(results[0].callId).toBe('call-001')
  })

  it('handles a call whose reference has no glossary/proper-noun terms', () => {
    const emptyCall = {
      callId: 'call-002',
      referenceText: 'nothing relevant here',
      properNouns: [],
      sources: { retell: 'x', elevenlabs: 'y', qwen: 'z' },
    }
    const result = scoreCall(emptyCall, GLOSSARY_TERMS)
    expect(result.expectedTerms).toEqual([])
    expect(result.sources.retell.accuracy).toBe(1)
  })
})

describe('aggregateBySource / rankSources', () => {
  const callScores = [
    {
      callId: 'call-001',
      expectedTerms: ['drip edge', 'ridge cap'],
      sources: {
        retell: { matched: ['drip edge', 'ridge cap'], missed: [], accuracy: 1 },
        elevenlabs: { matched: ['drip edge'], missed: ['ridge cap'], accuracy: 0.5 },
        qwen: { matched: [], missed: ['drip edge', 'ridge cap'], accuracy: 0 },
      },
    },
    {
      callId: 'call-002',
      expectedTerms: ['RCV'],
      sources: {
        retell: { matched: ['RCV'], missed: [], accuracy: 1 },
        elevenlabs: { matched: ['RCV'], missed: [], accuracy: 1 },
        qwen: { matched: [], missed: ['RCV'], accuracy: 0 },
      },
    },
    {
      // No expected terms — must be excluded from the aggregate denominator.
      callId: 'call-003',
      expectedTerms: [],
      sources: {
        retell: { matched: [], missed: [], accuracy: 1 },
        elevenlabs: { matched: [], missed: [], accuracy: 1 },
        qwen: { matched: [], missed: [], accuracy: 1 },
      },
    },
  ]

  it('micro-averages matched/expected across calls, excluding empty calls', () => {
    const aggregate = aggregateBySource(callScores)
    expect(aggregate.retell).toEqual({ matched: 3, expected: 3, accuracy: 1 })
    expect(aggregate.elevenlabs).toEqual({ matched: 2, expected: 3, accuracy: 2 / 3 })
    expect(aggregate.qwen).toEqual({ matched: 0, expected: 3, accuracy: 0 })
  })

  it('ranks sources by accuracy descending', () => {
    const ranking = rankSources(aggregateBySource(callScores))
    expect(ranking.map((r) => r.source)).toEqual(['retell', 'elevenlabs', 'qwen'])
  })

  it('treats a null accuracy (no data at all) as ranked last', () => {
    const aggregate = {
      retell: { matched: 1, expected: 2, accuracy: 0.5 },
      elevenlabs: { matched: 0, expected: 0, accuracy: null },
      qwen: { matched: 2, expected: 2, accuracy: 1 },
    }
    const ranking = rankSources(aggregate)
    expect(ranking.map((r) => r.source)).toEqual(['qwen', 'retell', 'elevenlabs'])
  })
})

describe('renderMarkdownReport', () => {
  const callScores = [
    {
      callId: 'call-001',
      expectedTerms: ['drip edge'],
      sources: {
        retell: { matched: ['drip edge'], missed: [], accuracy: 1 },
        elevenlabs: { matched: [], missed: ['drip edge'], accuracy: 0 },
        qwen: { matched: ['drip edge'], missed: [], accuracy: 1 },
      },
    },
  ]
  const aggregate = aggregateBySource(callScores)
  const ranking = rankSources(aggregate)

  it('includes a ranking table and per-call breakdown', () => {
    const report = renderMarkdownReport({
      callScores,
      aggregate,
      ranking,
      meta: {
        generatedAt: '2026-08-31T00:00:00.000Z',
        glossaryPath: 'glossary.json',
        callCount: 1,
      },
    })

    expect(report).toContain('# Adjuster ASR Vocabulary-Accuracy Comparison')
    expect(report).toContain('## Ranking')
    expect(report).toContain('## Per-call breakdown')
    expect(report).toContain('### call-001')
    expect(report).toContain('drip edge')
    expect(report).toContain('deferred')
  })

  it('notes calls with no expected terms instead of an empty table', () => {
    const report = renderMarkdownReport({
      callScores: [{ callId: 'call-empty', expectedTerms: [], sources: {} }],
      aggregate,
      ranking,
    })
    expect(report).toContain('No glossary or proper-noun terms found')
  })
})

describe('loadManifest', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function writeManifest(contents: unknown) {
    dir = mkdtempSync(join(tmpdir(), 'adjuster-asr-eval-test-'))
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(contents))
    return manifestPath
  }

  it('throws a clear error when the manifest JSON is not an array', () => {
    const manifestPath = writeManifest({ callId: 'call-001' })

    expect(() => loadManifest(manifestPath)).toThrow(/must be a JSON array/)
  })

  it('throws a clear error when a manifest entry is missing "reference"', () => {
    const manifestPath = writeManifest([{ callId: 'call-001', retell: 'retell.txt' }])

    expect(() => loadManifest(manifestPath)).toThrow(/call-001.*missing "reference"/)
  })

  it('loads a valid manifest and resolves each file relative to the manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'adjuster-asr-eval-test-'))
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(join(dir, 'reference.txt'), 'the roof needed a ridge cap')
    writeFileSync(join(dir, 'retell.txt'), 'the roof needed a ridge cap')
    writeFileSync(join(dir, 'elevenlabs.txt'), 'the roof needed a ridge cap')
    writeFileSync(join(dir, 'qwen.txt'), 'the roof needed a ridge cap')
    writeFileSync(
      manifestPath,
      JSON.stringify([
        {
          callId: 'call-001',
          reference: 'reference.txt',
          retell: 'retell.txt',
          elevenlabs: 'elevenlabs.txt',
          qwen: 'qwen.txt',
          properNouns: ['Smith'],
        },
      ]),
    )

    const calls = loadManifest(manifestPath)

    expect(calls).toEqual([
      {
        callId: 'call-001',
        referenceText: 'the roof needed a ridge cap',
        sources: {
          retell: 'the roof needed a ridge cap',
          elevenlabs: 'the roof needed a ridge cap',
          qwen: 'the roof needed a ridge cap',
        },
        properNouns: ['Smith'],
      },
    ])
  })
})
