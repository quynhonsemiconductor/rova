/**
 * Iteration Status' "Iteration End" counts WORKING days, not calendar days (BA ruling 2026-11-04).
 *
 * Sprint 1 runs Mon 2026-11-02 → Fri 2026-11-13: twelve calendar days, ten working days. The tile
 * read "of 12 days left", which counts two weekend days nobody works. The working days come from
 * `workspace_settings.working_days` (ISO 1 = Mon … 7 = Sun; Mon–Fri by default), the same column
 * the Burndown axis reads, so the tile and the chart cannot disagree about what a working day is.
 *
 * Pure date arithmetic on `YYYY-MM-DD` strings, parsed as UTC midnight: a calendar date has no
 * zone, and local parsing would shift the weekday for anyone west of UTC. "Today" arrives already
 * converted to the workspace's local date by the caller.
 *
 * Deliberately not imported from `@modules/reporting`'s `workingDaysBetween`: reporting READS
 * iterations, and the reverse import would point a core module at its own consumer.
 */
export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getTime();
}

function isoDayOfWeek(ms: number): number {
  const day = new Date(ms).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Working days from `start` to `end`, BOTH inclusive. 0 for an inverted range. */
export function countWorkingDays(
  start: string,
  end: string,
  workingDays: readonly number[] = DEFAULT_WORKING_DAYS,
): number {
  const from = toUtcMs(start);
  const to = toUtcMs(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d += DAY_MS) {
    if (workingDays.includes(isoDayOfWeek(d))) n++;
  }
  return n;
}

export interface IterationDayCount {
  /**
   * Working days still ahead, TODAY INCLUDED — today is a day the team can still work, so the
   * first day of a sprint reads "10 of 10" and its last day "1 of 10". Before the sprint starts it
   * equals `totalDays`. Once `today` is past the end it is NEGATIVE: the CALENDAR days overdue,
   * because "3 days overdue" states elapsed time, and counting only working days would let a
   * sprint ending on Friday read "0 days left" all weekend instead of overdue.
   * Null when there is no end date.
   */
  daysLeft: number | null;
  /** Working days in the whole window, both ends inclusive. Null without both dates. */
  totalDays: number | null;
}

export function iterationDayCount(input: {
  startDate: string | null;
  endDate: string | null;
  today: string;
  workingDays?: readonly number[];
}): IterationDayCount {
  const { startDate, endDate, today } = input;
  const workingDays = input.workingDays?.length ? input.workingDays : DEFAULT_WORKING_DAYS;

  const totalDays = startDate && endDate ? countWorkingDays(startDate, endDate, workingDays) : null;

  if (!endDate) return { daysLeft: null, totalDays };
  if (today > endDate) {
    return { daysLeft: -Math.round((toUtcMs(today) - toUtcMs(endDate)) / DAY_MS), totalDays };
  }
  const from = startDate && startDate > today ? startDate : today;
  return { daysLeft: countWorkingDays(from, endDate, workingDays), totalDays };
}
