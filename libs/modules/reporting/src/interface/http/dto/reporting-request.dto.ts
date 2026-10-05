import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

import { RELEASE_TRACKING_MAX_PAGE_SIZE } from '../../../domain/release-tracking';
import { CARRYOVER_DIRECTION_FILTERS } from '../../../domain/carryover';

/**
 * Every report query carries `projectId` and an OPTIONAL `teamId`, and nothing else about
 * scope: the SRS is explicit that "Project and Team come from the global workspace context.
 * A report must not create a second Project or Team filter."
 *
 * `projectId` is also what `@RequirePermission('report:view', { from: 'query', field:
 * 'projectId' })` resolves the project-tier check against, so it is required on every route
 * even where a release or iteration id would imply it.
 *
 * An absent `teamId` means All Teams — never "unfiltered". `.nullable()` because the SPA
 * serialises "no team selected" as an omitted parameter, and an empty string arrives from a
 * hand-built URL.
 */
const scope = {
  projectId: z.string().uuid(),
  teamId: z.string().uuid().optional().nullable(),
};

// ── GET /reports/iteration-burndown ──────────────────────────────────────────

export const IterationBurndownQuerySchema = z.object({
  ...scope,
  // The iteration the picker selected. For All Teams the server resolves its timebox group
  // and fuses every participating Team's iteration; the client never has to know the group.
  iterationId: z.string().uuid(),
});
export class IterationBurndownQueryDto extends createZodDto(IterationBurndownQuerySchema) {}

// ── GET /reports/velocity ────────────────────────────────────────────────────

export const VelocityQuerySchema = z.object({
  ...scope,
  // `Last 5 sprints` / `Last 10 sprints`. A closed enum rather than a clamped number: the
  // report offers exactly two windows, and the averages' sample-size reporting is only
  // meaningful against one of them.
  //
  // No default HERE, deliberately — it lives in `DEFAULT_VELOCITY_WINDOW`, which carries the
  // reasoning for why it is 10 (Rally's window) rather than §6's 5. Declaring one in the schema
  // too would put the same decision in two places and change the OpenAPI contract.
  window: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(5), z.literal(10)]))
    .optional(),
});
export class VelocityQueryDto extends createZodDto(VelocityQuerySchema) {}

// ── GET /reports/team-capacity ───────────────────────────────────────────────

export const TeamCapacityQuerySchema = z.object({
  ...scope,
  iterationId: z.string().uuid(),
});
export class TeamCapacityQueryDto extends createZodDto(TeamCapacityQuerySchema) {}

// ── GET /reports/carryover (Phase 7 CO-10) ───────────────────────────────────

export const CarryoverQuerySchema = z.object({
  ...scope,
  iterationId: z.string().uuid(),
  // Narrows the ROWS only (CO-BR-41) — never a KPI. Default `all`.
  direction: z.enum(CARRYOVER_DIRECTION_FILTERS).optional(),
});
export class CarryoverQueryDto extends createZodDto(CarryoverQuerySchema) {}

// ── GET /reports/release-tracking (+ /burnup) ────────────────────────────────

export const CHART_UNITS = ['points', 'count'] as const;
export const RELEASE_BUCKETS = ['direct', 'derived', 'unparented'] as const;

export const ReleaseTrackingQuerySchema = z.object({
  ...scope,
  releaseId: z.string().uuid(),
  // One unit selector drives both the grid's Status column and the chart (RT-BR-05).
  unit: z.enum(CHART_UNITS).optional(),
  // "The list filter displays one bucket at a time" (§5) — the rows returned are the active
  // bucket's, while all three summary totals come back regardless.
  bucket: z.enum(RELEASE_BUCKETS).optional(),
  /**
   * Paging over the ACTIVE BUCKET's rows only.
   *
   * The three summary counts, the Preliminary/Planned/Accepted totals and the burnup are
   * deliberately NOT paged — they are measured over the whole population, so a page of rows
   * never changes a number the reader is comparing against. `pageSize` is clamped rather
   * than validated to a closed set so the grid's own 10/25/50/100 selector all pass through.
   */
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(RELEASE_TRACKING_MAX_PAGE_SIZE).optional(),
  /**
   * Free-text search WITHIN the active bucket (§259), over the row's key and name.
   *
   * Server-side because the rows are one page: searching in the browser searched whichever 25
   * rows had arrived. `max(200)` is a bound, not a rule — a term longer than any key or name
   * cannot match anything and there is no reason to accept it.
   */
  q: z.string().trim().max(200).optional(),
  /**
   * `"<field>[:asc|:desc]"` over the whole bucket — `rank`, `id`, `team` or `name`
   * (RT-AC-05, plus the `name` Rally-parity divergence). Parsed by the shared `parseSort`
   * against `RELEASE_TRACKING_SORT_FIELDS`, so an unknown field falls back to rank order
   * instead of failing the request.
   */
  sort: z.string().optional(),
});
export class ReleaseTrackingQueryDto extends createZodDto(ReleaseTrackingQuerySchema) {}

export const ReleaseBurnupQuerySchema = z.object({
  ...scope,
  releaseId: z.string().uuid(),
  unit: z.enum(CHART_UNITS).optional(),
});
export class ReleaseBurnupQueryDto extends createZodDto(ReleaseBurnupQuerySchema) {}
