/**
 * Target End Date selection — the pure half (Phase 7 CO-03/CO-04, plan Task 4.1).
 *
 * The SERVER decides eligibility (`GET /work-items/:id/carryover-options`). This module only READS
 * that payload: which days the picker disables, and whether a picked day is a plain save or opens the
 * Carryover modal (and with which targets). It never re-derives which Iterations are eligible — the
 * list arrives already filtered, and a second copy of that rule in the browser is the
 * "picker narrower than the write" fault class.
 *
 * ISO `yyyy-MM-dd` strings compare lexicographically like the calendar, so no `Date` is built.
 */
import type { CarryoverOptionIteration, CarryoverOptions } from '../carryover-api'

type Options = Pick<CarryoverOptions, 'current' | 'eligibleIterations' | 'minDate'>

const contains = (it: Pick<CarryoverOptionIteration, 'startDate' | 'endDate'>, date: string) =>
  it.startDate <= date && date <= it.endDate

const afterCurrent = (date: string, options: Options) =>
  options.current?.endDate != null && date > options.current.endDate

/** Is this day selectable? Mirrors the server's `isEnabledDate` over the payload. */
export function isEnabledDate(date: string, options: Options): boolean {
  if (options.minDate === null || date < options.minDate) return false
  // R6 — an accepted current Iteration is not eligible, so its own window is never selectable.
  if (options.current && !options.current.eligible && !afterCurrent(date, options)) return false
  return options.eligibleIterations.some((it) => contains(it, date))
}

/**
 * What picking `date` means:
 *   • `inside`    — inside the current Iteration: save it, move nothing (CO-BR-17);
 *   • `carryover` — after the current Iteration: confirm a Carryover to one of `targets`
 *                   (one → proposed, several → the reader chooses, none → no destination).
 */
export type TargetEndSelection =
  { kind: 'inside' } | { kind: 'carryover'; targets: CarryoverOptionIteration[] }

export function resolveSelection(date: string, options: Options): TargetEndSelection {
  if (!afterCurrent(date, options)) return { kind: 'inside' }
  return {
    kind: 'carryover',
    targets: options.eligibleIterations.filter(
      (it) => it.id !== options.current?.id && contains(it, date),
    ),
  }
}
