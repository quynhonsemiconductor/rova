/**
 * Ratchet: every surface that renders `DetailLayout` must also pass `copyLink`.
 *
 * `Copy link` lives in the shared header precisely so it cannot drift between detail pages, but
 * "in the shared header" only guarantees the CONTROL is identical — a new detail page can still
 * omit the prop and ship without the feature, and nobody notices until a reader asks why one
 * record cannot be linked. This spec is what makes the coverage a rule rather than a convention,
 * the same job `route-permission.contract.test.tsx` does for permissions.
 *
 * If you are adding a detail page: pass `copyLink={{ key, name, url: entityDetailUrl(...) }}`.
 * If a surface genuinely addresses no linkable record, add it to `EXEMPT` with the reason — an
 * exemption is a decision, not a default.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = join(__dirname, '..', 'pages')

/** Surfaces that render the shell but address no record a reader would paste. */
const EXEMPT = new Map<string, string>([
  // Renders DetailLayout inside a test fixture, not a product surface.
  ['backlog/ui/collapse-to-summary.test.tsx', 'test fixture, not a page'],
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('detail surfaces expose Copy link', () => {
  const rendering = walk(PAGES)
    .filter((f) => /\.tsx$/.test(f))
    .filter((f) => /<DetailLayout[\s>]/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(PAGES.length + 1).replace(/\\/g, '/'))

  it('finds the detail surfaces at all (guards against a silent zero)', () => {
    // A regex that matches nothing would make every assertion below vacuously true.
    expect(rendering.length).toBeGreaterThanOrEqual(9)
  })

  it.each(rendering)('%s passes copyLink to DetailLayout', (rel) => {
    if (EXEMPT.has(rel)) return
    const source = readFileSync(join(PAGES, rel), 'utf8')
    expect(source, `${rel} renders DetailLayout without copyLink`).toMatch(/copyLink=/)
  })

  it('builds every link through the shared module, never from window.location', () => {
    // The Backlog mounts DetailHeader as a summary panel, where the current URL is the LIST — so a
    // link read off `window.location` would address the wrong thing from that surface. Either
    // shared builder is fine (`entityLinkFor` is the nullable-key wrapper over `entityDetailUrl`);
    // reading the address off the browser is not.
    for (const rel of rendering) {
      if (EXEMPT.has(rel)) continue
      const source = readFileSync(join(PAGES, rel), 'utf8')
      expect(source, `${rel} must import a link builder from shared/lib/entity-link`).toMatch(
        /from '@\/shared\/lib\/entity-link'/,
      )
      expect(source, `${rel} must not build a copy link from window.location`).not.toMatch(
        /copyLink=[\s\S]{0,200}window\.location/,
      )
    }
  })

  it('keeps every exemption justified', () => {
    for (const [rel, reason] of EXEMPT) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(10)
    }
  })
})
