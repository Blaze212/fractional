import '@testing-library/jest-dom'

// Node's experimental `--localstorage-file` global shadows jsdom's Web Storage
// with an incomplete object lacking getItem/setItem. Replace it with a simple
// Map-backed implementation so components relying on localStorage behave.
{
  const store = new Map<string, string>()
  const localStorageMock: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  })
}

// Stub Deno globals so edge function modules can be imported in Vitest/Node.
if (typeof globalThis.Deno === 'undefined') {
  const mockEnvStore: Record<string, string> = {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-anon-key',
    OPENAI_API_KEY: 'test-openai-key',
    LOG_LEVEL: 'silent',
    LOG_MIRROR_TO_CONSOLE: 'false',
  }

  Object.defineProperty(globalThis, 'Deno', {
    value: {
      env: {
        get: (key: string) => mockEnvStore[key],
        set: (key: string, val: string) => {
          mockEnvStore[key] = val
        },
      },
    },
    writable: true,
    configurable: true,
  })
}
