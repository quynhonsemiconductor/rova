/**
 * US-119 — the static User Guide under `public/guide` ships as the BA authored it, so its structure is
 * guarded here instead of by a formatter or linter. Each assertion protects an acceptance criterion or
 * the security posture of `functions/_lib/guide-gate.ts`:
 *
 * - every local link and image resolves (AC2 "local links load without error", AC4 "no broken assets");
 * - every Vietnamese page has an English counterpart and vice versa (AC2, the language switch maps by
 *   file name);
 * - every page header states the official version (AC4);
 * - nothing but web assets is published — `public/` is copied verbatim into `dist/`, so an authoring
 *   note such as the BA's `WRITING_BRIEF.md` would be served;
 * - no external origin and no inline script/style/handler, which is what lets the gate's CSP be
 *   `script-src 'self'; style-src 'self'` with no `unsafe-inline`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const GUIDE = resolve(import.meta.dirname, '../../public/guide')
const PUBLISHABLE = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files = walk(GUIDE)
const pages = files.filter((f) => f.endsWith('.html'))
const rel = (f: string) => relative(GUIDE, f).replaceAll('\\', '/')
const viPages = pages.filter((f) => !rel(f).startsWith('en/')).map((f) => rel(f))
const enPages = pages.filter((f) => rel(f).startsWith('en/')).map((f) => rel(f).slice(3))

const urlsIn = (html: string) => [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!)

describe('the published User Guide', () => {
  it('exists, with both languages', () => {
    expect(viPages).toContain('index.html')
    expect(enPages).toContain('index.html')
    expect(viPages.length).toBeGreaterThanOrEqual(13)
  })

  it('publishes web assets only — no authoring notes or other files', () => {
    const unexpected = files.map(rel).filter((f) => !PUBLISHABLE.has(extname(f).toLowerCase()))
    expect(unexpected).toEqual([])
  })

  it('has an English page for every Vietnamese page, and the reverse', () => {
    expect([...enPages].sort()).toEqual([...viPages].sort())
  })

  it.each(pages.map((p) => [rel(p), p]))('%s resolves every local link and asset', (_, page) => {
    const broken = urlsIn(readFileSync(page, 'utf8'))
      .filter((url) => !url.startsWith('#') && !url.startsWith('data:'))
      .map((url) => url.split('#')[0]!.split('?')[0]!)
      .filter((path) => path !== '' && !existsSync(resolve(dirname(page), path)))
    expect(broken).toEqual([])
  })

  it.each(pages.map((p) => [rel(p), p]))(
    '%s shows the official version in its header',
    (name, page) => {
      const label = name.startsWith('en/') ? 'Version 1.0' : 'Phiên bản 1.0'
      expect(readFileSync(page, 'utf8')).toMatch(
        new RegExp(`class="status-pill brand-version">${label}<`),
      )
    },
  )

  it.each(pages.map((p) => [rel(p), p]))('%s reaches no external origin', (_, page) => {
    const external = urlsIn(readFileSync(page, 'utf8')).filter((url) =>
      /^([a-z]+:)?\/\//i.test(url),
    )
    expect(external).toEqual([])
  })

  it.each(pages.map((p) => [rel(p), p]))(
    '%s has no inline script, style or event handler (the gate CSP forbids them)',
    (_, page) => {
      const html = readFileSync(page, 'utf8')
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
      expect(html).not.toMatch(/<style[\s>]/i)
      expect(html).not.toMatch(/\sstyle="/i)
      expect(html).not.toMatch(/\son[a-z]+="/i)
      expect(html).not.toMatch(/href="javascript:/i)
    },
  )

  it('keeps data: URLs to the inline favicon only', () => {
    for (const page of pages) {
      for (const url of urlsIn(readFileSync(page, 'utf8')).filter((u) => u.startsWith('data:'))) {
        expect(url, rel(page)).toMatch(/^data:image\/svg\+xml,/)
      }
    }
  })

  it('loads no external resource from the stylesheet', () => {
    const css = readFileSync(join(GUIDE, 'styles.css'), 'utf8')
    expect(css).not.toMatch(/@import|url\(\s*['"]?([a-z]+:)?\/\//i)
  })
})
