/**
 * SplitBanner — `Split · {Source} → {Target}` on both resulting Stories (SU-07 7.2/7.3, AC2/AC3).
 *
 * Two claims are worth making here and the second is the one that regresses:
 *
 *  1. The bar states the relationship and both keys, and the COUNTERPART is a real router link to
 *     `/item/$itemKey` — asserted through `href`, which is the only thing a reader can act on. Both
 *     directions are tested, because `role` is the only input that changes between them and the
 *     failure mode (linking to the page you are on) is invisible from one side.
 *  2. It says NOTHING ELSE. SRS §11 asks for a compact bar with no explanatory message, and the plan's
 *     §7 names absence as the part of this feature most likely to regress "because adding a helpful
 *     message feels like an improvement". Those assertions are against `document.body.textContent`, not
 *     a container — the app renders through portals elsewhere and a container-scoped absence has passed
 *     vacuously in this feature before (SU-01, fixed).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import '@/shared/i18n/i18n'
import type { SplitLink } from '@/features/work-items/split-api'
import { SplitBanner } from './split-banner'

/**
 * A real router, with the ONE route the banner links to.
 *
 * `createMemoryHistory` rather than a mocked `Link`: the claim is that the link ADDRESSES the
 * counterpart Story, and a mock that renders an `<a>` with whatever it was handed would assert the
 * test's own wiring. This resolves `to`/`params` through the router the app uses.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

const link = (over: Partial<SplitLink> = {}): SplitLink => ({
  splitId: 'split-1',
  splitAt: '2026-06-20T10:00:00.000Z',
  role: 'continued',
  sourceIterationId: 'iter-1',
  sourceIterationName: 'Sprint 26.1',
  targetIterationId: 'iter-3',
  targetIterationName: 'Sprint 26.2',
  unfinished: { id: 'wi-2', itemKey: 'US-9', title: 'Unfinished remainder' },
  continued: { id: 'wi-1', itemKey: 'US-1', title: 'Upgrade NX workspace to v21' },
  ...over,
})

/**
 * A real router, with the ONE route the banner links to.
 *
 * `createMemoryHistory` rather than a mocked `Link`: the claim is that the link ADDRESSES the
 * counterpart Story, and a mock that renders an `<a>` with whatever it was handed would assert the
 * test's own wiring. This resolves `to`/`params` through the router the app uses.
 *
 * AWAITED, because `RouterProvider` mounts its tree after the router resolves the initial match — a
 * synchronous `render` returns an empty body, which reads as "the component rendered nothing".
 */
async function renderBanner(splitLink: SplitLink) {
  const rootRoute = createRootRoute({ component: () => <SplitBanner splitLink={splitLink} /> })
  const itemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/item/$itemKey',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([itemRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const rendered = render(<RouterProvider router={router} />)
  await screen.findByRole('region', { name: 'Split relationship' })
  return rendered
}

/** Every string this component is forbidden from rendering (SRS §11). */
const FORBIDDEN = [/because/i, /was split/i, /this story has been/i, /warning/i, /unfinished work/i]

describe('SplitBanner (SU-07)', () => {
  it('states the source → target iterations and both story keys', async () => {
    await renderBanner(link())

    expect(screen.getByText('Split')).toBeInTheDocument()
    expect(screen.getByText('Sprint 26.1')).toBeInTheDocument()
    expect(screen.getByText('Sprint 26.2')).toBeInTheDocument()
    expect(screen.getByText('[Unfinished] US-9')).toBeInTheDocument()
    expect(screen.getByText('[Continued] US-1')).toBeInTheDocument()
  })

  it('links to the [Unfinished] side from the [Continued] Story, and not back to itself (AC3)', async () => {
    await renderBanner(link({ role: 'continued' }))

    const toUnfinished = screen.getByRole('link', { name: /Open the unfinished story US-9/ })
    expect(toUnfinished).toHaveAttribute('href', '/item/US-9')
    // The side the reader is already on is TEXT, not a link: a link back to this page does nothing,
    // and `aria-current` is how a screen reader is told which of the two it is on.
    expect(screen.queryByRole('link', { name: /Open the continued story/ })).not.toBeInTheDocument()
    expect(screen.getByText('[Continued] US-1')).toHaveAttribute('aria-current', 'page')
  })

  it('links the other way from the [Unfinished] Story (AC2 — the banner is on BOTH)', async () => {
    await renderBanner(link({ role: 'unfinished' }))

    const toContinued = screen.getByRole('link', { name: /Open the continued story US-1/ })
    expect(toContinued).toHaveAttribute('href', '/item/US-1')
    expect(
      screen.queryByRole('link', { name: /Open the unfinished story/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('[Unfinished] US-9')).toHaveAttribute('aria-current', 'page')
  })

  it('carries the story TITLE in the link’s accessible name, not only its key', async () => {
    // `US-9` alone tells a screen-reader user nothing about where the link goes, and the visible label
    // has no room for both.
    await renderBanner(link())

    expect(
      screen.getByRole('link', { name: 'Open the unfinished story US-9: Unfinished remainder' }),
    ).toBeInTheDocument()
  })

  it('renders `--` for an iteration whose name could not be resolved, never an empty gap', async () => {
    // A deleted sprint must degrade the bar, not delete the trace: the LINKS are what the banner is
    // for, and they still work.
    await renderBanner(link({ targetIterationName: null }))

    expect(screen.getByText('Sprint 26.1')).toBeInTheDocument()
    expect(screen.getByText('--')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the unfinished story US-9/ })).toBeInTheDocument()
  })

  it('renders NO explanatory sentence, no alert and no status region (SRS §11)', async () => {
    await renderBanner(link())

    for (const forbidden of FORBIDDEN) {
      expect(document.body.textContent).not.toMatch(forbidden)
    }
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
    // A relationship is not a problem: nothing here is marked invalid either.
    expect(document.body.querySelector('[aria-invalid="true"]')).toBeNull()
  })

  it('is one landmark with an accessible name, so the bar is addressable', async () => {
    await renderBanner(link())

    expect(screen.getByRole('region', { name: 'Split relationship' })).toBeInTheDocument()
  })
})
