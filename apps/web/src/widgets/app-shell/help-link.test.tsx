import '@/shared/i18n/i18n'
import { render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { HelpLink } from './help-link'

/**
 * A real router with the one route Help links to, so the claim is the `href` the reader can follow,
 * not a mocked `Link`'s props. Awaited: `RouterProvider` mounts after it resolves the first match.
 */
async function renderHelpLink(at = '/') {
  const rootRoute = createRootRoute({ component: HelpLink })
  const guideRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/user-guide/{-$lang}',
    component: () => null,
  })
  // A record route: a param of its own, which must not leak into the guide link.
  const itemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/item/$itemKey',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([guideRoute, itemRoute]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  render(<RouterProvider router={router} />)
  return screen.findByRole('link', { name: 'Open User Guide' })
}

describe('HelpLink', () => {
  it('opens the in-app guide in the same tab', async () => {
    const link = await renderHelpLink()
    expect(link).toHaveAttribute('href', '/user-guide')
    // Same tab (BA, 2026-10-30): no target, so no opener to cut either.
    expect(link).not.toHaveAttribute('target')
    // No hover tooltip (product decision, 2026-10-07); the accessible name comes from aria-label.
    expect(link).not.toHaveAttribute('title')
  })

  it('names no edition, so the guide picks it from the browser language', async () => {
    expect(await renderHelpLink('/item/US-17')).toHaveAttribute('href', '/user-guide')
  })

  it('keeps the edition the reader is in when Help is pressed inside the guide', async () => {
    // `params={true}`: the guide's own `lang` carries over, rather than the browser's edition.
    expect(await renderHelpLink('/user-guide/en')).toHaveAttribute('href', '/user-guide/en')
  })

  it('renders through the shared IconButton, which carries the target-size floor', async () => {
    expect(await renderHelpLink()).toHaveAttribute('data-slot', 'icon-button')
  })
})
