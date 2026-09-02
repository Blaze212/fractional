import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

// The adjuster pipeline calls paid vendors (OpenRouter, ElevenLabs, Qwen).
// loadGs runs every .gs file in a vm context seeded with `console` plus
// whatever the test passes in, so no network-capable global exists unless a
// test supplies a stub — an accidental vendor call in a unit test is an error,
// never a charge. That property is the reason unit tests are the default place
// to verify extraction and rendering behaviour, so it is asserted rather than
// assumed.
//
// Spec 021 moved the HTTP client from a UrlFetchApp global to an injected
// deps.fetch (see core/deps.js), which makes the second assertion below
// stronger rather than weaker: the sandbox has no network global to reach for,
// and core refuses to run without a client that was handed to it deliberately.
describe('unit test sandbox', () => {
  const NETWORK_GLOBALS = ['UrlFetchApp', 'fetch', 'XMLHttpRequest', 'require', 'process']

  it('exposes no network-capable global to a loaded script', () => {
    const sandbox = loadGs('apps/adjuster/src/util.js')

    NETWORK_GLOBALS.forEach((name) => expect(sandbox[name]).toBeUndefined())
  })

  it('the real OpenRouter call path throws instead of dialling out', () => {
    const sandbox = loadGs([
      'apps/adjuster/src/core/deps.js',
      'apps/adjuster/src/llm/openrouter.js',
    ])

    expect(() =>
      sandbox.callOpenRouter({ model: 'm', messages: [], jsonSchema: {}, apiKey: 'k' }),
    ).toThrow(/deps\.fetch is required/)
  })
})
