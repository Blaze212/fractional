// @vitest-environment node
//
// Node rather than the suite-wide jsdom: this file reads fixtures off disk and
// runs core in a bare vm, neither of which wants a DOM.
import { describe, expect, it } from 'vitest'
import {
  collectingLogger,
  diffValidated,
  listFixtures,
  loadCore,
  loadFixture,
  renderFieldDiff,
  replayFetch,
  REPLAY_CONFIG,
  runFixture,
} from './corpus'

// The regression corpus, replayed (spec 021 phase 3.7, BH-129).
//
// Each fixture under tests/fixtures/adjuster/calls/ holds one call's source
// transcripts, its claim and candidate list, the tagSchema and glossary, the
// voice platform's live export, the recorded LLM responses, and the validated
// field map those inputs are expected to produce. This suite runs core against
// all of them with the recorded responses replayed through a stub deps.fetch:
// deterministic, free, and it preserves the invariant that `pnpm test` cannot
// dial a vendor.
//
// The same fixtures run live in a separate opt-in CI job
// (.github/workflows/adjuster-corpus-live.yml), which is what makes a prompt or
// model change show its blast radius before it merges. See
// tests/fixtures/adjuster/README.md.

const FIXTURES = listFixtures()

describe('adjuster regression corpus', () => {
  it('has fixtures to run', () => {
    // A corpus that quietly emptied itself would turn every assertion below
    // into a no-op and the suite would still go green.
    expect(FIXTURES.length).toBeGreaterThan(0)
  })

  FIXTURES.forEach((name) => {
    describe(name, () => {
      it('produces the expected validated field map', () => {
        const core = loadCore()
        const fixture = loadFixture(name)
        const { fetch } = replayFetch(fixture)
        const { logger } = collectingLogger()

        const result = runFixture(core, fixture, { fetch, logger, sleep: () => {} }, REPLAY_CONFIG)

        expect(fixture.expected, `${name} has no expected-validated.json`).toBeTruthy()

        const diffs = diffValidated(fixture.expected!, result.validated)
        const changed = diffs.filter((diff) => !diff.same)

        expect(changed.length, `\n${renderFieldDiff(diffs)}\n`).toBe(0)
      })

      it('makes no network call, only replayed ones', () => {
        const core = loadCore()
        const fixture = loadFixture(name)
        const { fetch, seen } = replayFetch(fixture)
        const { logger } = collectingLogger()

        runFixture(core, fixture, { fetch, logger, sleep: () => {} }, REPLAY_CONFIG)

        // Every request core issued was answered from responses.json — an
        // unrecorded one throws inside replayFetch rather than reaching out.
        expect(seen.length).toBeGreaterThan(0)
        seen.forEach((schema) => expect(Object.keys(fixture.responses)).toContain(schema))
      })

      it('reaches for no Apps Script global and loads no config of its own', () => {
        const core = loadCore()
        const fixture = loadFixture(name)
        const { fetch } = replayFetch(fixture)
        const { logger, events } = collectingLogger()

        // No sleep either: a retry would have to work without one, and this
        // asserts the run never needed it.
        runFixture(core, fixture, { fetch, logger }, REPLAY_CONFIG)

        expect(events.map((e) => e.event)).toContain('runner.validated')
      })
    })
  })
})
