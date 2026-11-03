/**
 * Boot: fetch and validate `/config.json` FIRST, then load the application.
 *
 * The order is the contract. App modules read `ENV` once, when they are first imported
 * (`shared/config/env.ts`), so they must not be evaluated before the runtime config is applied —
 * which is why `main.tsx` loads the app with a dynamic `import()` AFTER `loadConfig` resolves,
 * instead of importing `App` at the top of the file.
 *
 * A missing or invalid config renders the error screen; it never leaves the window blank. If the app
 * chunk itself fails to load, that is a different failure and the app's own `preload-error` handling
 * reloads once.
 */
import { loadConfig } from '@/shared/config/config'
import { renderConfigError } from './config-error'

/** The app, loaded after the config: `bootstrap.tsx` exports `render`. */
export type AppLoader = () => Promise<{ render: (root: HTMLElement) => void }>

export interface BootOptions {
  root: HTMLElement
  /** Injected by the unit tests; the app uses `fetch`. */
  fetchImpl?: typeof fetch
  loadApp: AppLoader
}

export async function boot({ root, fetchImpl, loadApp }: BootOptions): Promise<void> {
  try {
    await loadConfig(fetchImpl)
  } catch (error) {
    renderConfigError(root, error)
    return
  }

  const { render } = await loadApp()
  render(root)
}
