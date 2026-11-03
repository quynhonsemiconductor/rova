/**
 * The screen the SPA shows when `/config.json` is missing or invalid.
 *
 * It is plain DOM on purpose: it runs BEFORE React, the i18n bundle and the stylesheet are loaded —
 * importing any of them is what the failed boot is not allowed to assume — and its job is simply to
 * replace the blank page with the reason. Values reach it through `textContent`, never HTML, because
 * the message quotes a server's answer.
 */
export const CONFIG_ERROR_TITLE = 'Rova could not start'

function line(doc: Document, tag: 'h1' | 'p' | 'pre', text: string): HTMLElement {
  const element = doc.createElement(tag)
  element.textContent = text
  return element
}

/**
 * Renders the error in `root`, replacing whatever is there, and renders a Reload button so a
 * transient failure (a rollout replacing config.json) costs one click.
 */
export function renderConfigError(root: HTMLElement, error: unknown): void {
  const doc = root.ownerDocument
  const container = doc.createElement('div')
  container.setAttribute('role', 'alert')
  container.dataset.testid = 'config-error'
  // System colours and no literal palette value: this runs before `globals.css`, so a `BRAND` token
  // (`var(--…)`) would resolve to nothing, and a raw hex is what the design-token ratchet forbids.
  // `color-scheme` lets the browser pick readable foreground/background in light and dark.
  container.style.cssText =
    'color-scheme: light dark; max-width: 42rem; margin: 15vh auto; padding: 2rem; font-family: system-ui, sans-serif;'

  const message = error instanceof Error ? error.message : String(error)
  const reload = doc.createElement('button')
  reload.type = 'button'
  reload.textContent = 'Reload'
  reload.style.cssText =
    'margin-top: 1rem; padding: 0.5rem 1rem; border: 1px solid currentColor; border-radius: 0.375rem; background: none; color: inherit; cursor: pointer; font: inherit;'
  reload.addEventListener('click', () => window.location.reload())

  container.append(
    line(doc, 'h1', CONFIG_ERROR_TITLE),
    line(doc, 'p', 'The application configuration could not be loaded, so there is nothing to show.'),
    line(doc, 'pre', message),
    reload,
  )

  root.replaceChildren(container)
}
