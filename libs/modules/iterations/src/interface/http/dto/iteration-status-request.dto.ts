import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PageQuerySchema } from '@platform';
import { UNASSIGNED_FILTER } from '@modules/work-items';
import { workItemTypeEnum, workItemScheduleStateEnum } from '../../../../../../../db/schema/enums';

/**
 * A NUMBER-input Manage Filters value, as it arrives on the query string.
 *
 * Kept as a string schema rather than `z.coerce.number()`: coercion maps `''` to
 * 0, so `?toDo=` would filter for rows with zero remaining hours instead of not
 * filtering at all — a control that narrows the list while reading as untouched.
 * The output is the fixed(2) string the numeric columns compare against.
 */
const numericFilter = z
  .union([
    z.literal(''),
    z
      .string()
      .trim()
      .regex(/^\d{1,6}(?:\.\d{1,2})?$/),
  ])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v).toFixed(2)));

// ── Iteration Status list query (P2-IS-04) ──────────────────────────────────────

export const IterationStatusQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(255).optional(),
  type: z.enum(workItemTypeEnum.enumValues).optional(),
  scheduleState: z.enum(workItemScheduleStateEnum.enumValues).optional(),
  /**
   * `'true'` / `'false'`, not `z.coerce.boolean()`.
   *
   * `z.coerce.boolean()` is `Boolean(value)`, and `Boolean('false')` is TRUE — so
   * `?isBlocked=false` asked for BLOCKED rows. It went unnoticed while the only
   * caller was a "Blocked items only" checkbox that either sent `true` or omitted
   * the param; the Manage Filters Blocked dropdown has a "Not blocked" value, and
   * it must not return the opposite set. (Same trap `booleanish` exists for in
   * `env.schema.ts`; CLAUDE.md records it.)
   */
  isBlocked: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // A UUID targets one owner; the sentinel filters unassigned rows (owner IS
  // NULL) — the same contract the Backlog list already offers.
  assigneeId: z.union([z.string().uuid(), z.literal(UNASSIGNED_FILTER)]).optional(),
  devOwnerId: z.union([z.string().uuid(), z.literal(UNASSIGNED_FILTER)]).optional(),
  // ── Manage Filters column predicates (P2-IS-FR-022/023/024) ─────────────────
  itemKey: z.string().trim().max(64).optional(),
  title: z.string().trim().max(500).optional(),
  planEstimate: numericFilter,
  taskEstimate: numericFilter,
  toDo: numericFilter,
  // Phase 7 Carryover — text filters over the two Story date columns (substring of `YYYY-MM-DD`).
  startDate: z.string().trim().max(10).optional(),
  targetEndDate: z.string().trim().max(10).optional(),
});

export class IterationStatusQueryDto extends createZodDto(IterationStatusQuerySchema) {}

// ── Create Story/Defect into the iteration (P2-IS-06) ────────────────────────────

export const CreateIterationItemSchema = z.object({
  // P2.3 restricts creation to story/defect (SRS §9.4 / FR-041).
  type: z.enum(['story', 'defect']),
  title: z.string().min(1).max(500).trim(),
  assigneeId: z.string().uuid().optional(),
  // story_points is numeric(6,2): accept fractional plan estimates and normalise
  // to a 2dp string for the numeric column (SRS §9.4).
  planEstimate: z.coerce
    .number()
    .min(0)
    .max(999)
    .transform((v) => v.toFixed(2))
    .optional(),
  /**
   * WHOSE work this is — required in practice for an Editor, optional in the contract.
   *
   * The service inherits the ITERATION's team when this is omitted, which is right for a team-scoped
   * sprint and impossible for a shared one: 195 of 206 local iterations name no team, and under the BA
   * ruling of 2026-08-17 an Editor "must select one of their assigned Teams when creating a Work Item".
   * Without this field, Add Item on a shared iteration answered `WORK_ITEM_TEAM_REQUIRED` with no way
   * for the form to comply — the surface was closed to exactly the role §3.2 grants it to.
   *
   * Optional rather than required because a Workspace Admin or Project Admin may still file into the
   * Project Backlog, and on a team-scoped iteration the inheritance is the better default. The
   * refusals live in `createWorkItem`, so this field cannot widen anyone's scope: a team that is not
   * the caller's is `TEAM_NOT_IN_SCOPE`.
   */
  teamId: z.string().uuid().optional(),
});

export class CreateIterationItemDto extends createZodDto(CreateIterationItemSchema) {}
