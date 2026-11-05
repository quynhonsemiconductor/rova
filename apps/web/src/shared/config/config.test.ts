import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH, ConfigError, configSchema, loadConfig } from './config'
import { ENV } from './env'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const VALID = { apiBaseUrl: '', appEnv: 'production', devLoginEnabled: false } as const

beforeEach(() => {
  ENV.API_BASE_URL = ''
  ENV.APP_ENV = 'development'
  ENV.DEV_LOGIN_ENABLED = false
  ENV.APP_VERSION = undefined
  ENV.APP_COMMIT = undefined
})

describe('configSchema', () => {
  it('accepts the same-origin and path forms of apiBaseUrl', () => {
    for (const apiBaseUrl of ['', '/', '/api', '/v1']) {
      expect(configSchema.safeParse({ ...VALID, apiBaseUrl }).success).toBe(true)
    }
  })

  it('rejects an apiBaseUrl that leaves this origin', () => {
    for (const apiBaseUrl of [
      'api',
      '//evil.example.com',
      '/\\evil.example.com',
      'https://api.example.com',
      'http://localhost:3000',
      'ftp://example.com',
      ' localhost',
    ]) {
      expect(configSchema.safeParse({ ...VALID, apiBaseUrl }).success).toBe(false)
    }
  })

  it('rejects an unknown appEnv, a string boolean and a missing field', () => {
    expect(configSchema.safeParse({ ...VALID, appEnv: 'dev' }).success).toBe(false)
    expect(configSchema.safeParse({ ...VALID, devLoginEnabled: 'true' }).success).toBe(false)
    expect(configSchema.safeParse({ apiBaseUrl: '', appEnv: 'production' }).success).toBe(false)
  })
})

describe('loadConfig', () => {
  it('fetches /config.json without caching and applies it to ENV', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VALID))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).resolves.toEqual(VALID)

    expect(fetchImpl).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(ENV).toMatchObject({
      API_BASE_URL: '',
      APP_ENV: 'production',
      DEV_LOGIN_ENABLED: false,
    })
  })

  it('applies the dev login switch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...VALID, devLoginEnabled: true }))

    await loadConfig(fetchImpl as unknown as typeof fetch)

    expect(ENV.DEV_LOGIN_ENABLED).toBe(true)
  })

  it('applies the chart-rendered image tag and commit when the config carries them', async () => {
    // qnsc-service >= 0.19.3 merges these into the ConfigMap from the web image tag. An older chart
    // renders neither, and the schema must still accept the config (they are optional).
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ...VALID, appVersion: 'sha-0123456789ab', appCommit: '0123456789ab' }),
      )

    await loadConfig(fetchImpl as unknown as typeof fetch)

    expect(ENV.APP_VERSION).toBe('sha-0123456789ab')
    expect(ENV.APP_COMMIT).toBe('0123456789ab')
  })

  it('leaves the version unknown rather than inventing one when the config omits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VALID))

    await loadConfig(fetchImpl as unknown as typeof fetch)

    expect(ENV.APP_VERSION).toBeUndefined()
    expect(ENV.APP_COMMIT).toBeUndefined()
  })

  it('treats an empty version and commit as unknown instead of failing the boot', async () => {
    // A chart that renders "" (a digest-only pin, an unset value) must not put every reader on the
    // startup error screen: the version line says "unknown", exactly as when the keys are absent.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...VALID, appVersion: '', appCommit: '' }))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).resolves.toBeTruthy()

    expect(ENV.APP_VERSION).toBeUndefined()
    expect(ENV.APP_COMMIT).toBeUndefined()
  })

  it('treats JSON null like an absent version and commit instead of failing the boot', () => {
    // A templated chart can render `null` for an unset value; YAML/JSON does not distinguish it
    // from absent once parsed, and neither must the schema.
    const parsed = configSchema.safeParse({ ...VALID, appVersion: null, appCommit: null })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.appVersion).toBeUndefined()
    expect(parsed.success && parsed.data.appCommit).toBeUndefined()
  })

  it('keeps a non-commit appCommit out of the UI without failing the boot', () => {
    for (const value of ['v0.1.2', 'sha-0123456789ab', 'prod', 'abc', '0123456789abzz']) {
      const parsed = configSchema.safeParse({ ...VALID, appCommit: value })
      expect(parsed.success, value).toBe(true)
      expect(parsed.success && parsed.data.appCommit, value).toBeUndefined()
    }
  })

  it('lowercases and trims a hex appCommit', () => {
    const parsed = configSchema.safeParse({ ...VALID, appCommit: '  ABC1234 ' })
    expect(parsed.success && parsed.data.appCommit).toBe('abc1234')
  })

  it('fails with the status when the file is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(ConfigError)
    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow('HTTP 404')
  })

  it('fails when the answer is not JSON (an SPA fallback page, for instance)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 200 }))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'is not valid JSON',
    )
  })

  it('fails with the field errors when the shape is wrong', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ apiBaseUrl: '', appEnv: 'dev', devLoginEnabled: false }))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /is invalid:[\s\S]*appEnv/,
    )
    // Nothing was applied, so the app keeps its defaults rather than a half-read config.
    expect(ENV.APP_ENV).toBe('development')
  })

  it('fails when the request itself fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(loadConfig(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'Could not fetch /config.json: Failed to fetch',
    )
  })
})
