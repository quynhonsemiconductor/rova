/**
 * The SPA's runtime environment, as the rest of the app reads it.
 *
 * The DEPLOYED values are not baked into the bundle: the SPA fetches `/config.json` once, before it
 * bootstraps (`shared/config/config.ts`), and `applyConfig` fills this object in. One image therefore
 * serves every environment, and a value changes with a ConfigMap, not a rebuild.
 *
 * `IS_DEV` is the exception: it is the Vite dev server itself (`import.meta.env.DEV`), a build-time
 * fact of the bundle, not an environment of the product.
 *
 * The defaults below are what a module sees when it is imported before (or without) a config — the
 * unit tests — and they match the old build-time defaults.
 */
import type { AppConfig, AppEnv } from './config'

export interface Env {
  /**
   * The API origin prefix, e.g. `''` for same-origin (what every deployment uses), or an absolute
   * `https://` URL. Keep it same-origin: authentication rides a `__Host-` session cookie, which a
   * cross-site request would not carry.
   */
  API_BASE_URL: string
  APP_ENV: AppEnv
  /** The Vite dev server (`vite`), never true in a build. */
  IS_DEV: boolean
  /** The passwordless dev-login affordance (seeded accounts, no Entra). */
  DEV_LOGIN_ENABLED: boolean
}

export const ENV: Env = {
  API_BASE_URL: '',
  APP_ENV: 'development',
  IS_DEV: import.meta.env.DEV,
  DEV_LOGIN_ENABLED: false,
}

/** Fills `ENV` from a validated `/config.json`. Called once, by `loadConfig`. */
export function applyConfig(config: AppConfig): void {
  ENV.API_BASE_URL = config.apiBaseUrl
  ENV.APP_ENV = config.appEnv
  ENV.DEV_LOGIN_ENABLED = config.devLoginEnabled
}
