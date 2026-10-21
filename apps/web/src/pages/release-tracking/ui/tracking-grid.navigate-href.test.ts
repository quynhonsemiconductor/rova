/**
 * `openItem` (and the Issues panel) navigate with `navigate({ href })`, the one place in the app that
 * does — so this runs it on a REAL TanStack router rather than a mock: an in-app path must move the
 * router's own location (no document reload), exactly like `navigate({ to, params })`.
 */
import { describe, expect, it } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

function makeRouter() {
  const rootRoute = createRootRoute()
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/item/$itemKey' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/portfolio/$itemId' }),
  ])
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
}

describe('navigate({ href }) with an in-app path', () => {
  it.each([
    ['/item/US-9', 'itemKey', 'US-9'],
    ['/portfolio/f-1', 'itemId', 'f-1'],
  ])('moves the router to %s and matches its route', async (href, param, value) => {
    const router = makeRouter()
    await router.load()

    await router.navigate({ href })

    expect(router.state.location.pathname).toBe(href)
    const match = router.state.matches.at(-1)
    expect((match?.params as Record<string, string>)[param]).toBe(value)
  })
})
