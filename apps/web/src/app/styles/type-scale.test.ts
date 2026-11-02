/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buttonVariants } from '@/shared/ui/button'
import { iconButtonVariants } from '@/shared/ui/icon-button'
import { TARGET_HEIGHT, TARGET_MIN_PX, TARGET_SQUARE } from '@/shared/ui/target-size'

/**
 * The `text-ui-*` scale, pinned three ways.
 *
 * The tokens are declared as `rem` with the intended px in a trailing comment, and `html` pins the
 * root to an absolute 14px — so the comment is the only statement of what a reader actually sees, and
 * a rem edited without its comment (or a root changed without the tokens) silently moves every size in
 * the app. The first case recomputes each token against the real root rather than trusting either.
 *
 * The floor is 11px. `--text-ui-2xs` (9px) was retired on 2026-08-20: it was 32 nodes of badge and
 * meta text below anything the product it models renders, and keeping the token defined would let it
 * come back one class at a time.
 *
 * The root is a PERCENTAGE of the reader's own default, so "14px" here means "14px for the 16px
 * browser default" — the px comments are read the same way. An absolute px root would discard that
 * preference, which is what the literal `14px` this replaced did.
 */
/** What the CSS spec gives as the initial `font-size`, and what every mainstream browser defaults to. */
const BROWSER_DEFAULT_PX = 16
const css = readFileSync(join(import.meta.dirname, './globals.css'), 'utf8')

const ROOT_PERCENT = Number(/html\s*\{[^}]*font-size:\s*([\d.]+)%/.exec(css)?.[1])
const ROOT_PX = (ROOT_PERCENT / 100) * BROWSER_DEFAULT_PX

/** Every `--text-ui-<name>` declaration with its rem value and its px comment, in source order. */
const SCALE = [...css.matchAll(/--text-ui-([a-z0-9]+):\s*([\d.]+)rem;\s*\/\* (\d+)px \*\//g)].map(
  ([, name, rem, px]) => ({ name, rem: Number(rem), px: Number(px) }),
)

describe('text-ui-* type scale', () => {
  it('reads a relative root that resolves to 14px, and five sizes', () => {
    // A `px` root here would parse as NaN and fail every case below — which is the point: the
    // preference-discarding form cannot come back quietly.
    expect(ROOT_PERCENT).toBe(87.5)
    expect(ROOT_PX).toBe(14)
    expect(SCALE.map((s) => s.name)).toEqual(['xs', 'sm', 'md', 'lg', 'xl'])
  })

  it.each(SCALE)('--text-ui-$name resolves to the $px px its comment claims', ({ rem, px }) => {
    // Sub-half-pixel, so a rem rounded to six places passes and a stale comment does not.
    expect(Math.abs(rem * ROOT_PX - px)).toBeLessThan(0.5)
  })

  it('ascends, and nothing renders below the 11px floor', () => {
    const px = SCALE.map((s) => s.px)
    expect(px).toEqual([...px].sort((a, b) => a - b))
    expect(new Set(px).size).toBe(px.length)
    expect(Math.min(...px)).toBeGreaterThanOrEqual(11)
  })

  it('does not define the retired 9px token', () => {
    expect(css).not.toMatch(/--text-ui-2xs\s*:/)
  })
})

/** Every `--text-doc-<name>` size and line height, with its px comment — the User Guide's scale. */
const DOC_SCALE = [
  ...css.matchAll(/--text-doc-([a-z0-9]+(?:--line-height)?):\s*([\d.]+)rem;\s*\/\* ([\d.]+)px/g),
].map(([, name, rem, px]) => ({ name, rem: Number(rem), px: Number(px) }))

describe('text-doc-* type scale', () => {
  it('declares a size and a line height for each of its seven steps', () => {
    const sizes = DOC_SCALE.filter((s) => !s.name.endsWith('--line-height')).map((s) => s.name)
    expect(sizes).toEqual(['sm', 'body', 'lead', 'h3', 'h2', 'title', 'display'])
    expect(DOC_SCALE).toHaveLength(sizes.length * 2)
  })

  it.each(DOC_SCALE)(
    '--text-doc-$name resolves to the $px px its comment claims',
    ({ rem, px }) => {
      // Same reading as the ui scale: against the real 87.5% root, never trusting the comment alone.
      expect(Math.abs(rem * ROOT_PX - px)).toBeLessThan(0.5)
    },
  )
})

/**
 * WCAG 2.5.8 Target Size (Minimum, AA) — the floor is defined once in `target-size.ts`; these cases
 * prove the definition and that every control the audit measured under it now carries it.
 *
 * They read CLASS STRINGS rather than rendering, deliberately: jsdom computes no layout, so a rendered
 * assertion here would report 0×0 for every element and pass on nothing. What a class-string test can
 * still catch is the regression that actually happened — a control styled for density with no floor at
 * all — and the px-versus-rem trap, which is a textual property of the class.
 */
describe('the pointer-target floor is defined once', () => {
  it('states the criterion in CSS px, not rem', () => {
    // `min-h-6` is 1.5rem = 21px against this root: under the floor, from the class meant to hold it.
    expect(TARGET_MIN_PX).toBe(24)
    expect(TARGET_SQUARE).toBe(`min-h-[${TARGET_MIN_PX}px] min-w-[${TARGET_MIN_PX}px]`)
    expect(TARGET_HEIGHT).toBe(`min-h-[${TARGET_MIN_PX}px]`)
  })

  it('is the only definition of it in shared/ui', () => {
    // A second literal is a second decision. Every other control composes the constants above.
    const owners = readdirSync(join(import.meta.dirname, '../../shared/ui'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .filter((f) =>
        readFileSync(join(import.meta.dirname, '../../shared/ui', f), 'utf8').includes(
          `min-h-[${TARGET_MIN_PX}px]`,
        ),
      )
    expect(owners).toEqual(['target-size.ts'])
  })
})

describe('Button meets the 24px target-size minimum', () => {
  it.each(['md', 'sm', 'xs', 'icon'] as const)('size=%s carries the floor', (size) => {
    expect(buttonVariants({ size })).toContain(TARGET_HEIGHT)
  })

  it('gives the icon-only size a width floor too', () => {
    // Square target: an icon button has no text to widen it.
    expect(buttonVariants({ size: 'icon' })).toContain(TARGET_SQUARE)
  })
})

describe('IconButton meets it at every size', () => {
  it.each(['sm', 'md', 'lg'] as const)('size=%s is a square target', (size) => {
    // The floor is in the BASE class, not per size: the sizes are padding around the caller's icon,
    // so a new size could otherwise arrive under the minimum without touching this file.
    expect(iconButtonVariants({ size })).toContain(TARGET_SQUARE)
  })
})

describe('the controls the audit measured under the floor now carry it', () => {
  const SOURCES = join(import.meta.dirname, '../../shared/ui')
  const source = (f: string) => readFileSync(join(SOURCES, f), 'utf8')

  // Measured heights before the change, at a 14px root: modal close 18.5px, pagination arrows 23.5px,
  // kebab trigger 25.5px (kept for consistency, it is the same gesture), grip ~14px, chevron 12px.
  it.each([
    ['app-modal.tsx', 'TARGET_SQUARE'],
    ['pagination-footer.tsx', 'TARGET_SQUARE'],
    ['action-menu.tsx', 'TARGET_SQUARE'],
    // Height only: both sit in a grid's left gutter, where 34px rows already satisfy 2.5.8's SPACING
    // exception, and widening them would push every grid across by 6.5px for nothing.
    ['drag-handle.tsx', 'TARGET_HEIGHT'],
    ['row-expand-toggle.tsx', 'TARGET_HEIGHT'],
  ])('%s composes %s', (file, constant) => {
    expect(source(file)).toContain(constant)
  })
})
