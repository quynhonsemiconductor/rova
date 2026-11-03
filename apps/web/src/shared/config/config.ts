/**
 * The SPA's runtime configuration: `/config.json`, fetched once before the app bootstraps.
 *
 * The bundle is built ONCE and promoted by digest, so nothing environment-specific may be compiled
 * into it. The deploying environment (gitops, per env) mounts a `config.json` next to `dist/`; this
 * module fetches it, validates every field, and only then hands control to the app. A missing or
 * invalid config is an ERROR SCREEN (`app/config-error.ts`), never a blank page: the alternative is a
 * white window and a console nobody reads.
 *
 * The dev server answers `/config.json` itself (`vite.config.ts`, `devConfigPlugin`), so `pnpm dev`
 * needs no file and a build never contains one.
 */
import { z } from 'zod'
import { applyConfig } from './env'

/** Where the config is served, and where a deployment mounts it. Same-origin, always. */
export const CONFIG_PATH = '/config.json'

export type AppEnv = 'development' | 'staging' | 'production'

/** `''` (same origin), a path such as `/api`, or an absolute http(s) origin. Not `//host` — that is protocol-relative. */
function isApiBaseUrl(value: string): boolean {
  if (value === '') return true
  if (value.startsWith('/')) return !value.startsWith('//')
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * The whole contract, and it is strict in the ways that matter: an unknown `appEnv`, a `"true"`
 * string instead of a boolean, or an `apiBaseUrl` that is neither a path nor a URL is a
 * misconfigured deployment, and it fails at boot rather than at the first request.
 */
export const configSchema = z.object({
  apiBaseUrl: z
    .string()
    .refine(
      isApiBaseUrl,
      'must be "" (same origin), a path starting with a single "/", or an absolute http(s) URL',
    ),
  appEnv: z.enum(['development', 'staging', 'production']),
  devLoginEnabled: z.boolean(),
})

export type AppConfig = z.infer<typeof configSchema>

/** A config that could not be fetched or did not validate. The message is shown on the error screen. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetches and validates `/config.json`, then applies it to `ENV`. Callers must not import app modules
 * before this resolves: they read `ENV` once, at module load.
 *
 * `fetchImpl` is injectable for the unit tests; the app always uses `fetch`.
 */
export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  let response: Response
  try {
    // `no-store`: the file is small and must never be a stale cached copy (the server also sends
    // `Cache-Control: no-cache`, but a proxy is not the only cache to consider).
    response = await fetchImpl(CONFIG_PATH, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    throw new ConfigError(`Could not fetch ${CONFIG_PATH}: ${describe(error)}`)
  }

  if (!response.ok) {
    throw new ConfigError(
      `${CONFIG_PATH} answered HTTP ${response.status}. The deployment must mount it next to the app.`,
    )
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${describe(error)}`)
  }

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(`${CONFIG_PATH} is invalid:\n${z.prettifyError(parsed.error)}`)
  }

  applyConfig(parsed.data)
  return parsed.data
}
