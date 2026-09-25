import { useCallback } from 'react'
import { useRouter, useRouterState } from '@tanstack/react-router'

/**
 * The selected tab of a detail page, kept in the URL instead of in component state.
 *
 * WHY (DE-19). Every detail page held its tab in `useState`, so the tab was a fact about a mounted
 * component rather than about the place the reader was in. A route component unmounts when you leave
 * it, which makes Back structurally unable to return you where you were: open a Story, go to its
 * Test Cases tab, open a Test Case, press Back — `useDetailBack` walks the history stack correctly,
 * the right Story loads, and its tab state is born again at `details`. The reader has to find the
 * list they were just reading. US-93 TC-23's AC1 asks for the list.
 *
 * The URL is the only store that survives that round trip, because it is the thing the history entry
 * actually holds. It also makes a tab linkable and refresh-stable, which state never was.
 *
 * `replace`, not push, and it matters in both directions:
 *   • the CURRENT history entry is rewritten, so the entry the reader will come Back to already
 *     carries the tab — that is the fix;
 *   • no entry is added, so a tab click does not put a step in the stack that Back has to walk
 *     through one at a time. Browser Back keeps meaning "the previous PAGE", which is what a reader
 *     expects of it and what the app's own Back button is built on.
 *
 * The fallback tab is written as NO parameter rather than `?tab=details`, so the default view of a
 * record has one canonical URL — the one that gets shared and bookmarked.
 *
 * Read via `useRouterState` and written via `router.history`, deliberately: no route in this app
 * declares `validateSearch` (see `accept-invitation-page.tsx`), so there is no typed search schema
 * to route this through, and declaring one on the record routes would make `search` part of the
 * contract of every `Link` that opens them.
 *
 * APPLIED TO the three pages of the chain the defect was reported against — Work Item, Test Case,
 * Test Result. The other detail surfaces (Releases, Milestones, Portfolio, Projects, Capacity Plan,
 * Iteration) still hold their tab in `useState` and still lose it on Back; tracked as issue #644
 * rather than batched in here, so the fix stays the size of the defect.
 */
export function useDetailTab<T extends string>(
  /** Every tab the page can show — anything else in the URL is ignored. */
  tabs: readonly T[],
  /** The tab shown when the URL names none, or names one this page does not have. */
  fallback: T,
): [T, (tab: T) => void] {
  const router = useRouter()
  const location = useRouterState({ select: (s) => s.location })

  const raw = (location.search as Record<string, unknown> | undefined)?.tab
  const active = typeof raw === 'string' && tabs.includes(raw as T) ? (raw as T) : fallback

  const setTab = useCallback(
    (tab: T) => {
      const params = new URLSearchParams(location.searchStr)
      if (tab === fallback) params.delete('tab')
      else params.set('tab', tab)
      const query = params.toString()
      const href = `${location.pathname}${query ? `?${query}` : ''}`
      // Re-selecting the tab already in the URL must not rewrite the entry the tab is stored in:
      // a byte-identical `replaceState` + router commit buys nothing, and this handler runs on every
      // click of the active tab. An explicit `?tab=details` still passes, because the href built for
      // the fallback carries no parameter and therefore differs from it — so that URL normalises to
      // the canonical one on the next selection instead of being frozen by this guard.
      if (href === `${location.pathname}${location.searchStr}`) return
      router.history.replace(href)
    },
    [router, location.pathname, location.searchStr, fallback],
  )

  return [active, setTab]
}
