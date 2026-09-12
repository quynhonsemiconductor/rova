/**
 * "Step to the earlier/later row" for any timebox feed — one rule for every prev/next chevron in
 * the app, chronology rather than array arithmetic.
 *
 * Two surfaces implemented this rule separately and reversed it twice for the same reason:
 * `index ± 1` carries no chronological meaning on its own — whether `+1` means "earlier" or
 * "later" is a property of the FEED's order, and nothing at a bare `move(1)` call site said which.
 * Iteration Status reversed both chevrons this way (Production, 2026-08-21: from KB Sprint 1 the
 * left chevron advanced to KB Sprint 2). `TimeboxPicker` then reintroduced the same shape for
 * Reports' Iteration Burndown picker, this time reversing the FORWARD arrow, because it hardcoded
 * the assumption "newest first" where Iteration Status's own feed lives — one true for iterations
 * (`desc(startDate)`) and false for releases (`asc(startDate)`), which `TimeboxPicker` also serves.
 *
 * `feedDirection` reads the order from the data instead of assuming it, so one function is correct
 * for both feeds, and a later change to either one's server-side ordering breaks a test on THIS
 * function rather than silently reversing whichever caller assumed the old order.
 */

export interface TimeboxLike {
  startDate: string | null
}

/**
 * `1` if `items` runs oldest-to-newest, `-1` if newest-to-oldest — read from the first and last
 * DATED rows, so an undated row (a "None" option, or a release nobody has scheduled) at either end
 * cannot be mistaken for the feed's actual direction. Defaults to `1` (oldest-to-newest) when there
 * are fewer than two dated rows to compare — with 0 or 1 dated rows `stepIndexInTime` never finds a
 * second one to land on, so the exact default is unreachable; it exists only so this function
 * always returns a direction rather than `null`.
 */
export function feedDirection(items: readonly TimeboxLike[]): 1 | -1 {
  const dated = items.filter(
    (it): it is TimeboxLike & { startDate: string } => it.startDate !== null,
  )
  if (dated.length < 2) return 1
  const first = dated[0].startDate
  const last = dated[dated.length - 1].startDate
  return first <= last ? 1 : -1
}

/**
 * The index of the row one step EARLIER or LATER than `index` in TIME, or `null` when there is
 * none — skipping undated rows, which are not a position in time to step through or land on.
 *
 * `direction` names the step in chronology, never an array offset: the caller says "earlier" or
 * "later" and this resolves that against `direction`'s actual array order (`+1` or `-1`), so a
 * later change to a feed's sort order breaks this one tested expression instead of silently
 * reversing whichever chevron assumed the old order.
 */
export function stepIndexInTime<T extends TimeboxLike>(
  items: readonly T[],
  index: number,
  direction: 'earlier' | 'later',
): number | null {
  if (index < 0 || index >= items.length) return null
  const dir = feedDirection(items)
  const step = direction === 'earlier' ? -dir : dir
  let next = index + step
  while (next >= 0 && next < items.length) {
    if (items[next].startDate !== null) return next
    next += step
  }
  return null
}
