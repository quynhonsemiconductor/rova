import { BRAND } from '@/shared/config/brand'

type DateRange = { startDate?: string | null; endDate?: string | null }

/** `start - end` label for an iteration, with em-dash fallbacks for missing bounds. */
export function fmtRange(it: DateRange): string {
  const s = it.startDate ?? '--'
  const e = it.endDate ?? '--'
  return `${s} - ${e}`
}

/**
 * Inclusive CALENDAR day count; defaults to 10 when bounds are missing. Internal: only the
 * in-flight fallback of `iterationEndWidget`, whose real total is the server's working days.
 */
function computeTotalDays(it: DateRange | undefined): number {
  if (!it?.startDate || !it?.endDate) return 10
  const start = new Date(it.startDate)
  const end = new Date(it.endDate)
  const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  return Math.max(1, diff)
}

export interface IterationEndDisplay {
  iterationEnd: { value: string; label: string; color: string }
  iterationProgressPct: number
}

/**
 * The "Iteration End" tile: its value, label, colour and elapsed bar, in one place so Done and
 * Overdue never degrade to a misleading "0 days left".
 *
 * The total is the server's `totalDays` — WORKING days in the workspace's own working-day setting
 * (BA 2026-11-04: Sprint 1 Mon 11-02 → Fri 11-13 is 10 days, not 12), the same calendar
 * `daysLeft` is counted in. The calendar count is only the fallback while the status read is in
 * flight, when `daysLeft` is null as well and the tile reads `--` anyway.
 */
export function iterationEndWidget(
  iteration: (DateRange & { state?: string | null }) | undefined,
  metrics: { daysLeft?: number | null; totalDays?: number | null } | undefined,
): IterationEndDisplay {
  // Kept nullable: an iteration with NO end date has no days-left, and `?? 0` fed the elapsed-bar
  // arithmetic where it reads as "the whole iteration has elapsed".
  const daysLeft = metrics?.daysLeft ?? null
  const tDays = metrics?.totalDays ?? computeTotalDays(iteration)
  // Finished once accepted, regardless of the end-date arithmetic. `state === 'accepted'` alone:
  // `iterations.completed_at` is the ACCEPTANCE stamp and the service writes it on accept and
  // clears it on every other transition (`iterations.service.ts`), so the two move in lockstep and
  // the reference feed deliberately does not carry it.
  const done = iteration?.state === 'accepted'

  return {
    iterationEnd: endTile(done, daysLeft, tDays),
    iterationProgressPct: elapsedPct(done, daysLeft, tDays),
  }
}

/** Elapsed / total, capped at 100%; a finished iteration always shows full. */
function elapsedPct(done: boolean, daysLeft: number | null, tDays: number): number {
  if (done) return 100
  if (tDays <= 0 || daysLeft === null) return 0
  return Math.min(((tDays - Math.max(daysLeft, 0)) / tDays) * 100, 100)
}

function endTile(
  done: boolean,
  daysLeft: number | null,
  tDays: number,
): IterationEndDisplay['iterationEnd'] {
  if (done) return { value: 'Done', label: 'Completed', color: BRAND.success }
  if (daysLeft === null) return { value: '--', label: 'no end date', color: BRAND.warning }
  if (daysLeft < 0) {
    return {
      value: String(Math.abs(daysLeft)),
      label: daysLeft === -1 ? 'day overdue' : 'days overdue',
      color: BRAND.danger,
    }
  }
  return { value: String(daysLeft), label: `of ${tDays} days left`, color: BRAND.warning }
}

/** One scoped Story/Defect row, in the only fields the Totals row reads. */
export type TotalsRow = {
  planEstimate?: number | null
  toDo?: number | null
  actual?: number | null
}

/**
 * The Totals row under the column header — `P2-IS-FR-016B/016C`, over the SCOPED parents.
 *
 * `taskEst` is `To Do + Actual`, NOT the sum of the `Task Est` column. The BA states that twice —
 * FR-016C ("Task Est total sums child Task `To Do + Actual`") and §240's mapping table ("Sum child
 * Task `toDo + actuals` for scoped Story/Defect parents") — so it is the requirement, not a slip.
 *
 * It therefore does not equal the column above it, and that is inherent to the definition rather
 * than an arithmetic bug: the column is Rally's `TaskEstimateTotal`, a rollup of each Task's own
 * Estimate (§203), while this total is remaining plus spent. The two agree only while nothing has
 * been logged. Raised with the BA; if they mean the column's sum, `toDo + actual` here is the one
 * expression to change back.
 */
export function iterationStatusTotals(rows: readonly TotalsRow[]): {
  planEst: number
  taskEst: number
  toDoSum: number
  actualSum: number
  count: number
} {
  let planEst = 0
  let taskEst = 0
  let toDoSum = 0
  let actualSum = 0
  for (const row of rows) {
    planEst += row.planEstimate ?? 0
    taskEst += (row.toDo ?? 0) + (row.actual ?? 0)
    toDoSum += row.toDo ?? 0
    actualSum += row.actual ?? 0
  }
  return {
    planEst: roundToTenth(planEst),
    taskEst: roundToTenth(taskEst),
    toDoSum: roundToTenth(toDoSum),
    actualSum: roundToTenth(actualSum),
    count: rows.length,
  }
}

/**
 * One decimal place — a PRODUCT decision, not an inferred display precision.
 *
 * Requested for Production on 2026-10-05 ("round those decimals to the first place") after the
 * float sums printed `43.200000000000001 Hours` and the label overflowed into the next column. Inputs
 * can carry hundredths (`story_points` is `numeric(6,2)`), so `14.52` deliberately shows as `14.5`
 * here — the Totals row is a summary, and the per-row cells still show each item's exact value.
 *
 * Rounded on the NUMBER because the label interpolates it raw (`"{{value}} Points"`) and
 * `TableFooterTotals` is its only consumer. Anything needing the exact sum must not read these
 * totals; compute it from the rows.
 */
function roundToTenth(n: number): number {
  // Snap to whole hundredths first — the inputs' own grid — so a half-way sum rounds up as written.
  // A float sum such as 8.45 + 2.10 is 10.549999…, which rounds DOWN on its own; adding
  // `Number.EPSILON` does not help, as it is far below one ulp of any total above 1.
  return Math.round(Math.round(n * 100) / 10) / 10
}

/** A row's sortable fields, in the shape the comparator reads. */
export type SortableStatusRow = {
  rank: string
  itemKey: string
  title: string
  scheduleState: string
  isBlocked: boolean
  planEstimate?: number | null
  taskEstimate?: number | null
  toDo?: number | null
  assigneeName?: string | null
  devOwnerName?: string | null
}

/**
 * The value a column sorts on — `P2-IS-FR-025/026` and §286's `sortBy`.
 *
 * `null` means the row has no value for this column, and the comparator places those rows LAST in
 * ascending order, matching the keyset rule every server-side grid in the app follows (ASC → NULLS
 * LAST). Empty-string-as-zero would instead float unassigned rows to the top of an A-Z sort.
 *
 * Two mappings are worth stating:
 *  - `flowState` returns the SCHEDULE state, because the Flow State cell reads and writes that same
 *    field on this screen. One value, one ordering.
 *  - `owner` / `devOwner` return the joined NAME, never the id. They used to compare `assigneeId` —
 *    a uuid — so the header offered a sort and produced an order arbitrary to any reader, which is
 *    indistinguishable from a broken one. Dev Owner had no mapping at all and its header was inert.
 *
 * `iteration` and `feature` are absent deliberately: this grid is scoped to ONE iteration, so every
 * row's Iteration is the same value, and Feature is not in §286's list.
 */
export function statusSortValue(
  row: SortableStatusRow,
  column: string,
): string | number | null | undefined {
  switch (column) {
    case 'rank':
      return row.rank
    case 'id':
      return row.itemKey
    case 'name':
      return row.title.toLowerCase()
    case 'scheduleState':
    case 'flowState':
      return row.scheduleState
    case 'block':
      return row.isBlocked ? 1 : 0
    case 'planEstimate':
      return row.planEstimate ?? null
    case 'taskEstimate':
      return row.taskEstimate ?? null
    case 'toDo':
      return row.toDo ?? null
    case 'owner':
      return row.assigneeName?.toLowerCase() ?? null
    case 'devOwner':
      return row.devOwnerName?.toLowerCase() ?? null
    default:
      // An unmapped column sorts nothing rather than ordering by an arbitrary key.
      return undefined
  }
}

/**
 * Sort the rows of one iteration by a column, nulls last in ASC and first in DESC.
 *
 * Client-side on purpose: `useIterationStatus` follows the cursor and loads the WHOLE iteration
 * (the Board view needs every row to allow drag), so the set being ordered is complete and a server
 * `sortBy` would be a second definition of one ordering. That is also why the sort disables rank
 * drag — the visual order stops being rank.
 */
export function sortStatusRows<T extends SortableStatusRow>(
  rows: readonly T[],
  column: string | null,
  direction: 'asc' | 'desc',
): readonly T[] {
  if (!column) return rows
  const dir = direction === 'asc' ? 1 : -1
  const isAbsent = (v: unknown) => v === null || v === undefined
  return [...rows].sort((a, b) => {
    const va = statusSortValue(a, column)
    const vb = statusSortValue(b, column)
    if (isAbsent(va) && isAbsent(vb)) return 0
    // Nulls last ascending, first descending — the shared keyset rule, so a column sorted here and
    // the same column sorted by a server-side grid do not disagree about where blanks belong.
    if (isAbsent(va)) return 1 * dir
    if (isAbsent(vb)) return -1 * dir
    if (va! < vb!) return -1 * dir
    if (va! > vb!) return 1 * dir
    return 0
  })
}

/**
 * The "step to the earlier/later iteration" rule used to live here as `stepIndexInTime(index,
 * direction, count)`, fixed for exactly this screen's chevrons (Production, 2026-08-21: from KB
 * Sprint 1 the left chevron advanced to KB Sprint 2). `TimeboxPicker` then needed the same rule for
 * a feed that runs the OPPOSITE direction (releases, `asc(startDate)`) and reintroduced the bug for
 * itself by copying the fix rather than the rule — this function's `index ± 1` hardcoded
 * newest-first, which is only one of the two orders `TimeboxPicker` serves.
 *
 * Promoted to `shared/lib/step-in-time.ts`, which reads the feed's actual direction from the data
 * instead of assuming it, so the one function is correct for both. Import `stepIndexInTime` from
 * there.
 */
