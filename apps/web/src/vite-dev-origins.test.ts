import { afterEach, describe, expect, it, vi } from 'vitest'

// The dev server rewrites index.html's default API and storage origins to the ones the root .env configures. The
// config reads the environment at load, so each case loads it fresh.
async function loadDevOrigins() {
  vi.resetModules()
  return (await import('../vite.config')).devOrigins
}

describe('devOrigins', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('leaves the default origins as they are', async () => {
    vi.stubEnv('API_TARGET', '')
    vi.stubEnv('PORT', '')
    vi.stubEnv('STORAGE_ENDPOINT', '')
    const html = 'connect-src http://localhost:3010 http://localhost:4620'
    expect((await loadDevOrigins())(html)).toBe(html)
  })

  it('rewrites the API and storage origins to the configured ones, and no other port', async () => {
    vi.stubEnv('API_TARGET', 'http://localhost:23000')
    vi.stubEnv('STORAGE_ENDPOINT', 'http://localhost:24620')
    const html =
      'connect-src http://localhost:3000 http://localhost:4620 http://localhost:30000 https://x.qnsc.vn:3000'
    expect((await loadDevOrigins())(html)).toBe(
      'connect-src http://localhost:23000 http://localhost:24620 http://localhost:30000 https://x.qnsc.vn:3000',
    )
  })
})
