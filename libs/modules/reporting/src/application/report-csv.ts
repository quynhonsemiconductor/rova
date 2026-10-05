import { workspaceLocalDate } from '../domain/report-scope';
import type {
  CarryoverReport,
  IterationBurndownReport,
  TeamCapacityReport,
  VelocityReport,
} from '../domain/reporting.types';

/**
 * CSV export for the four reports (Phase 7 Carryover rulings R1/R4, plan D11).
 *
 * Pure: each builder takes the SAME report object the JSON route returns, so an export can never
 * disagree with the screen it was exported from — filters included (the Carryover rows arrive
 * already Direction-filtered).
 *
 * RFC 4180: CRLF line endings, every field quoted when it contains a quote, comma, CR or LF, and
 * quotes doubled. A UTF-8 BOM leads the file so spreadsheet tools read non-ASCII names correctly.
 *
 * FORMULA INJECTION GUARD: a cell beginning with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`.
 * Story titles and Iteration names are user-authored, and a spreadsheet would otherwise EXECUTE
 * `=HYPERLINK(...)` typed into a title. Applied to text cells only — a negative NUMBER is data, and
 * prefixing it would turn it into text.
 */

export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
export const CSV_BOM = '\uFEFF';

/** One text cell, guarded and escaped. */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function cell(value: CsvCell): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return csvText(value);
}

/** A whole document: header + rows, CRLF-terminated, BOM-prefixed. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  const lines = [header.map((h) => csvText(h)), ...rows.map((row) => row.map(cell))];
  return CSV_BOM + lines.map((line) => line.join(',')).join('\r\n') + '\r\n';
}

export function burndownCsv(report: IterationBurndownReport): string {
  return toCsv(
    ['Date', 'Remaining To Do (h)', 'Accepted Points', 'Ideal (h)'],
    report.points.map((p) => [p.date, p.remainingToDo, p.acceptedPoints, p.ideal]),
  );
}

export function velocityCsv(report: VelocityReport): string {
  return toCsv(
    [
      'Timebox',
      'Start Date',
      'End Date',
      'Accepted During',
      'Accepted After',
      'Not Accepted',
      'Unclassified',
      'Split Carryover',
    ],
    report.bars.map((b) => [
      b.name,
      b.startDate,
      b.endDate,
      b.acceptedDuring,
      b.acceptedAfter,
      b.notAccepted,
      b.unclassified,
      b.splitCarryover,
    ]),
  );
}

export function teamCapacityCsv(report: TeamCapacityReport): string {
  const rows: CsvCell[][] = [];
  for (const team of report.teams) {
    for (const member of team.members) {
      rows.push([
        team.name,
        member.name,
        member.hours.capacityHours,
        member.hours.estimateHours,
        member.hours.todoHours,
        member.hours.actualHours,
      ]);
    }
    rows.push([
      team.name,
      'Team total',
      team.totals.capacityHours,
      team.totals.estimateHours,
      team.totals.todoHours,
      team.totals.actualHours,
    ]);
  }
  rows.push([
    'All',
    'Total',
    report.totals.capacityHours,
    report.totals.estimateHours,
    report.totals.todoHours,
    report.totals.actualHours,
  ]);
  return toCsv(['Team', 'Member', 'Capacity (h)', 'Estimate (h)', 'To Do (h)', 'Actual (h)'], rows);
}

/** The SRS column order (CO-BR-40); Moved On is the workspace-local calendar day. */
export function carryoverCsv(report: CarryoverReport): string {
  return toCsv(
    [
      'Direction',
      'Work Item',
      'Name',
      'From',
      'To',
      'Moved On',
      'Start Date',
      'Target End',
      'Estimate (h)',
      'To Do (h)',
      'Actual Before (h)',
      'Actual After (h)',
    ],
    report.rows.map((r) => [
      r.direction === 'in' ? 'Carry In' : 'Carry Out',
      r.storyKey,
      r.storyTitle,
      r.fromIterationName,
      r.toIterationName,
      workspaceLocalDate(new Date(r.movedAt), report.context.timeZone),
      r.startDate,
      r.targetEndDate,
      r.estimateHours,
      r.todoHours,
      r.actualBefore,
      r.actualAfter,
    ]),
  );
}

/** `<report>-<project>-<scope>.csv`, reduced to a filename-safe slug. */
export function exportFilename(report: string, project: string, scope: string): string {
  const slug = (v: string) =>
    v
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      // Trim AGAIN after the cut: truncation can land on a hyphen (#653 review).
      .replace(/-+$/, '') || 'report';
  return `${slug(report)}-${slug(project)}-${slug(scope)}.csv`;
}
