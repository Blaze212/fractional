import { describe, expect, it } from 'vitest'
import { loadGs } from './loadGs'

// The adjuster pipeline calls paid vendors (OpenRouter, ElevenLabs, Qwen) through
// UrlFetchApp. loadGs runs every .gs file in a vm context seeded with `console`
// plus whatever the test passes in, so none of those globals exist unless a test
// supplies a stub — an accidental vendor call in a unit test is a ReferenceError,
// never a charge. That property is the reason unit tests are the default place to
// verify extraction and rendering behaviour, so it is asserted rather than assumed.
describe('unit test sandbox', () => {
  const NETWORK_GLOBALS = ['UrlFetchApp', 'fetch', 'XMLHttpRequest', 'require', 'process']

  it('exposes no network-capable global to a loaded script', () => {
    const sandbox = loadGs('apps/adjuster/src/util.js')

    NETWORK_GLOBALS.forEach((name) => expect(sandbox[name]).toBeUndefined())
  })

  it('the real OpenRouter call path throws instead of dialling out', () => {
    const sandbox = loadGs('apps/adjuster/src/llm/openrouter.js', {
      logEvent: () => {},
      logServerOnly: () => {},
    })

    expect(() =>
      sandbox.callOpenRouter({ model: 'm', messages: [], jsonSchema: {}, apiKey: 'k' }),
    ).toThrow(/UrlFetchApp is not defined/)
  })
})
