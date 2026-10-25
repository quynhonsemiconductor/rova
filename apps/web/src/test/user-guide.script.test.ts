/**
 * US-119 — `public/guide/guide.js` on the URLs Cloudflare Pages actually serves.
 *
 * Pages 308-redirects `/guide/01-lam-quen.html` to `/guide/01-lam-quen` and `index.html` to the bare
 * folder. The script used to identify the current page by the raw last path segment, so on the
 * extensionless URL it `location.replace`d back to `….html`, which Pages redirected again — a loop —
 * and menu highlighting (AC3) and the language switch (AC2) compared names that could never match.
 * None of it reproduces under `file://` or the Vite dev server, which is why it is pinned here.
 *
 * The script runs against the real guide HTML with a `window` whose `location.replace` and `href`
 * setter are recorded rather than performed (jsdom cannot navigate), so "no navigation" is an
 * observable fact and the language switch's target URL can be asserted exactly.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const GUIDE = resolve(import.meta.dirname, '../../public/guide')
const SCRIPT = readFileSync(resolve(GUIDE, 'guide.js'), 'utf8')

interface Run {
  replaced: string[]
  assigned: string[]
}

const listeners: Array<[string, EventListenerOrEventListenerObject]> = []

beforeAll(() => {
  // Not implemented by jsdom; the script scrolls the requested section into view on `load`.
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  for (const [type, fn] of listeners.splice(0)) window.removeEventListener(type, fn)
})

/** Load `file` (relative to public/guide) as the document at `urlPath`, then run guide.js. */
function openGuide(file: string, urlPath: string): Run {
  const html = readFileSync(resolve(GUIDE, file), 'utf8')
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement)
  window.history.replaceState(null, '', urlPath)

  const run: Run = { replaced: [], assigned: [] }
  const real = window.location
  const location = {
    get href() {
      return real.href
    },
    set href(value: string) {
      run.assigned.push(value)
    },
    get pathname() {
      return real.pathname
    },
    get hash() {
      return real.hash
    },
    get origin() {
      return real.origin
    },
    replace: (value: string) => run.replaced.push(value),
  }
  const guideWindow = new Proxy(window, {
    get(target, prop) {
      if (prop === 'location') return location
      if (prop === 'addEventListener') {
        return (type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
          listeners.push([type, fn])
          target.addEventListener(type, fn, opts as AddEventListenerOptions)
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    },
  })

  new Function('window', SCRIPT)(guideWindow)
  return run
}

const activeNavHref = () => document.querySelector('.nav-item.active')?.getAttribute('href')
const activeSubmenuHref = () => document.querySelector('.submenu a.active')?.getAttribute('href')
const breadcrumb = () => document.querySelector('.breadcrumb strong')?.textContent

function chooseLanguage(value: 'vi' | 'en') {
  const select = document.querySelector<HTMLSelectElement>('#guide-language')!
  select.value = value
  select.dispatchEvent(new Event('change'))
}

describe('guide.js on Cloudflare Pages URLs', () => {
  it.each(['/guide/01-lam-quen', '/guide/01-lam-quen.html'])(
    'stays on the chapter at %s and highlights it',
    (path) => {
      const run = openGuide('01-lam-quen.html', path)
      expect(run.replaced).toEqual([])
      // The chapter's own nav link is a same-page link, so it was rewritten to a plain fragment.
      expect(activeNavHref()).toBe('#chapter-01')
      expect(breadcrumb()).toBe('01. Làm quen')
    },
  )

  it('stays on the guide home at the bare folder URL', () => {
    const run = openGuide('index.html', '/guide/')
    expect(run.replaced).toEqual([])
    expect(activeNavHref()).toBe('#gioi-thieu')
  })

  it('highlights the requested section of an English chapter at its extensionless URL', () => {
    const run = openGuide('en/05-lap-ke-hoach.html', '/guide/en/05-lap-ke-hoach#tao-iteration')
    expect(run.replaced).toEqual([])
    expect(activeNavHref()).toBe('#chapter-05')
    // Same-page links are rewritten to plain fragments so they scroll instead of reloading.
    expect(activeSubmenuHref()).toBe('#tao-iteration')
    expect(breadcrumb()).toMatch(/^05\. /)
  })

  it('still moves a section link to the chapter that owns it', () => {
    const run = openGuide('01-lam-quen.html', '/guide/01-lam-quen#tao-user-story')
    expect(run.replaced).toEqual(['03-backlog-cong-viec.html#tao-user-story'])
  })

  it('keeps links to OTHER chapters as page links', () => {
    openGuide('01-lam-quen.html', '/guide/01-lam-quen')
    const next = document.querySelector('.chapter-nav-link.next')?.getAttribute('href')
    expect(next).toBe('02-truy-cap-pham-vi.html#chapter-02')
  })

  it('switches Vietnamese → English to the same page and section', () => {
    const run = openGuide('01-lam-quen.html', '/guide/01-lam-quen#doi-tuong-cong-viec')
    chooseLanguage('en')
    expect(run.assigned).toEqual(['en/01-lam-quen.html#doi-tuong-cong-viec'])
  })

  it('switches English → Vietnamese from the bare English folder', () => {
    const run = openGuide('en/index.html', '/guide/en/')
    chooseLanguage('vi')
    expect(run.assigned).toEqual(['../index.html#gioi-thieu'])
  })

  it.each([
    ['01-lam-quen.html', '/guide/01-lam-quen'],
    ['01-lam-quen.html', '/guide/01-lam-quen#doi-tuong-cong-viec'],
  ])('finishes loading %s at %s without a script error', (file, path) => {
    // Found in real Chromium: with no fragment the `load` handler called `''?.scrollIntoView()`,
    // which throws and cancelled the highlight refresh queued after it.
    openGuide(file, path)
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => {
      errors.push(e.error ?? e.message)
      e.preventDefault()
    }
    window.addEventListener('error', onError)
    try {
      window.dispatchEvent(new Event('load'))
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toEqual([])
  })
})
