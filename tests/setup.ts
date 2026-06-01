import '@testing-library/jest-dom'

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
