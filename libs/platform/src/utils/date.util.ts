/**
 * Date / duration helpers — single source for time-offset math so TTL logic is
 * not re-derived (and mis-derived) at each call site.
 */
import { z } from 'zod';

/**
 * A calendar date on the wire: `YYYY-MM-DD`, no time and no zone.
 *
 * Shared because `date` columns are compared and displayed as plain calendar days —
 * accepting a full ISO timestamp would let a client's zone shift the stored day. This
 * was copy-pasted identically into the releases and projects DTOs; keep new date
 * fields on this one so the error message and the accepted shape stay uniform.
 */
export const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format');

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Returns a new Date `days` from `from` (default now). */
export function addDays(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/** Returns a new Date `hours` from `from` (default now). */
export function addHours(hours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + hours * MS_PER_HOUR);
}

// ── Workspace-local date boundaries ─────────────────────────────────────────
//
// "All timestamps and date cutoffs use the Workspace timezone. Store timestamps in UTC and convert
// to Workspace local date when applying an end-of-day or Iteration-end boundary." Implemented with
// `Intl` rather than a date library: the backend has no date dependency, and pulling one in for two
// functions would be the larger change.
//
// MOVED HERE FROM `reporting/domain/report-scope.ts` BY SU-06 (Split), which needs the same
// conversion on a WRITE path: the Split Event stores the marker dates its burndown annotations sit
// on, clamped into each iteration's window, and clamping needs the workspace-local date. The
// alternatives were both worse — `work-items` importing `@modules/reporting` inverts the dependency
// (reporting reads work items, not the reverse), and a second copy of the offset math is exactly what
// the plan's §8 Q17 reuse ruling forbids. `report-scope.ts` re-exports both names, so every existing
// import keeps working and there is still ONE implementation.

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const at = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour` formats midnight as 24 under hour12:false in some ICU versions.
  const hour = at('hour') % 24;
  const asIfUtc = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    hour,
    at('minute'),
    at('second'),
  );
  // Compare against the instant truncated to whole seconds. Intl reports no milliseconds, so
  // subtracting the untruncated instant would fold the instant's own fractional second into the
  // offset — enough to push a 23:59:59.999 boundary a second past midnight.
  return asIfUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

/** The workspace-local calendar date (`YYYY-MM-DD`) an instant falls on. */
export function workspaceLocalDate(instant: Date, timeZone: string): string {
  return new Date(instant.getTime() + zoneOffsetMs(instant, timeZone)).toISOString().slice(0, 10);
}

/**
 * The instant a workspace-local day ENDS — the cutoff `acceptedDate <= endOfDay(d)` compares
 * against.
 *
 * Two passes: the offset has to be read at roughly the target instant, because reading it at the
 * wrong side of a DST change would move the boundary by an hour and silently reclassify an item
 * accepted late on the last evening of an iteration.
 */
export function endOfWorkspaceDay(localDate: string, timeZone: string): Date {
  const naive = new Date(`${localDate}T23:59:59.999Z`).getTime();
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** The instant a workspace-local day BEGINS. Same two-pass DST handling as its end. */
export function startOfWorkspaceDay(localDate: string, timeZone: string): Date {
  const naive = new Date(`${localDate}T00:00:00.000Z`).getTime();
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/**
 * Parse a duration string into seconds. Accepts a bare number (seconds) or a
 * value suffixed with s/m/h/d (e.g. '15m', '1h', '7d', '30s', '900').
 * Used to keep client-facing `expiresIn` in sync with the JWT signing config.
 */
export function parseDurationToSeconds(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${duration}"`);
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return value * 24 * 60 * 60;
    case 'h':
      return value * 60 * 60;
    case 'm':
      return value * 60;
    case 's':
    case undefined:
    default:
      return value;
  }
}
