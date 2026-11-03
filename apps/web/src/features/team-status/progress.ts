/**
 * Member LOAD on Team Status — ONE formula, wherever the row is drawn from.
 *
 * `Load % = estimateHours / capacityHours * 100` (BA, US-145: "capacity 60h, a task estimated 8h →
 * the State bar reads 8/60"). The server computes exactly this in `TeamStatusService.buildMemberGroup`
 * for the unfiltered group; this is the same rule for the State-filtered view.
 *
 * It REVERSES Team_Status SRS §10's `actualHours / estimateHours`, which measured hours burned, so a
 * member with planned work but no Actuals logged yet — every member on day one of a sprint — read 0%.
 *
 * - NOT capped at 100: an over-committed member must read above it; the bar clamps its own width.
 * - `0` when no capacity is entered — there is nothing to measure load against. The page tells that
 *   case apart from a genuine 0% by reading `capacityHours` itself (see `ProgressBar`).
 *
 * Why the filtered view still calls this rather than reusing the server's number: a filter may change
 * the POPULATION a number is measured over (only the visible tasks' estimate counts); it may never
 * change the formula. The page once recomputed the bar as a task COUNT ratio under a filter, and the
 * same label then meant two different things.
 */
export function memberProgressPercent(estimateHours: number, capacityHours: number): number {
  if (!(capacityHours > 0)) return 0
  return Math.round((estimateHours / capacityHours) * 100)
}
