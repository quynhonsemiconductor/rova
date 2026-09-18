/**
 * Split a User Story — the HTTP contract.
 *
 * SU-01 ships the RESPONSE half only: `GET /work-items/:id/split-preview`. The request half
 * (`SplitWorkItemSchema`) lands with the write path in SU-06 (plan §3.2), so nothing here advertises
 * a body the server would refuse.
 *
 * TWO CONTRACT RULES THAT BITE IN THIS FILE:
 *
 *  1. **No `z.date()`, ever.** `nestjs-zod` throws "Date cannot be represented in JSON Schema" when
 *     the OpenAPI factory runs at bootstrap, which takes down every suite that boots through
 *     `bootstrapApp` — not just this route. Timestamps are `z.string().datetime()`. There are none in
 *     this response: `startDate`/`endDate` are `date` columns and stay ISO `YYYY-MM-DD` strings, so
 *     they are plain `z.string()` and NOT `.datetime()`, which would reject a date without a time.
 *
 *  2. **Field names mirror each entity's own column**, rather than being flattened to one word: a
 *     Story and a Task carry `title` (as `WorkItemResponseSchema` already does), an Iteration carries
 *     `name`, a Test Case carries `name`. The modal's visible label may read "Name" — that comes from
 *     `t()` and is a display concern, not a field name.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  iterationStateEnum,
  workItemPriorityEnum,
  workItemScheduleStateEnum,
} from '../../../../../../../db/schema/enums';
import { SPLIT_INELIGIBLE_REASONS, SPLIT_SIDES } from '../../../application/split-story';
import { WorkItemResponseSchema } from './work-item-response.dto';

/**
 * Which resulting Story an item starts on. `unfinished` is the historical placeholder that stays in
 * the source Iteration; `continued` is the original Story, moved to the target.
 *
 * The members come from `SPLIT_SIDES` rather than being re-typed here — same rule as the three
 * Drizzle enums above, which read `enumValues`: a member list is declared once and every other
 * mention derives from it, so the wire contract cannot disagree with the domain type.
 */
export const SplitSideSchema = z.enum(SPLIT_SIDES);

/**
 * Why Split is unavailable — **for telemetry and tests only.**
 *
 * SRS §11 and every AC require the control to be disabled with NO explanatory message, so the SPA
 * reads `eligible` alone and must never render this. It is in the contract so an e2e can assert which
 * rule refused, which a boolean cannot distinguish.
 *
 * Members from `SPLIT_INELIGIBLE_REASONS`; see {@link SplitSideSchema}.
 */
export const SplitIneligibleReasonSchema = z.enum(SPLIT_INELIGIBLE_REASONS);

export const SplitPreviewStorySchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  planEstimate: z
    .number()
    .nullable()
    .describe('work_items.story_points — the BA\u2019s "Plan Estimate". null = unpointed, not 0.'),
  scheduleState: z.enum(workItemScheduleStateEnum.enumValues),
  releaseId: z.string().uuid().nullable(),
  releaseName: z
    .string()
    .nullable()
    .describe(
      'Resolved from the row\u2019s own release_id, not from a release feed: an Editor holds no ' +
        'release:view, so a name sourced from an offer list would be absent for the callers who ' +
        'own the Story.',
    ),
  iterationId: z.string().uuid().nullable(),
  iterationName: z.string().nullable(),
  teamId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
});

export const SplitPreviewTargetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().describe('iterations.name'),
  iterationKey: z.string().nullable(),
  state: z.enum(iterationStateEnum.enumValues),
  startDate: z
    .string()
    .nullable()
    .describe('ISO date YYYY-MM-DD — a date column, never .datetime()'),
  endDate: z.string().nullable().describe('ISO date YYYY-MM-DD'),
});

export const SplitPreviewDefaultsSchema = z.object({
  unfinishedTitle: z
    .string()
    .describe('BR-12 — "[Unfinished] " + the bare title (Q10 strips any existing prefix)'),
  continuedTitle: z.string().describe('BR-12 — "[Continued] " + the bare title'),
  targetIterationId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      'BR-06 — the EARLIEST valid target. null when there is none (⇒ ineligible, no_target).',
    ),
});

export const SplitPreviewTaskSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  state: z
    .enum(workItemScheduleStateEnum.enumValues)
    .describe(
      'work.tasks.state — defined｜in_progress｜completed, a subset of the schedule states',
    ),
  todoHours: z.number().nullable(),
  estimateHours: z.number().nullable(),
  actualHours: z.number().nullable(),
  defaultSide: SplitSideSchema.describe(
    'BR-14 — a Completed Task defaults to [Unfinished]; every other Task to [Continued]. Decided ' +
      'server-side and never re-derived in the browser.',
  ),
});

export const SplitPreviewDefectSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  scheduleState: z.enum(workItemScheduleStateEnum.enumValues),
  priority: z.enum(workItemPriorityEnum.enumValues),
  explicitIterationId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      'BR-18 — the Defect\u2019s OWN Iteration, which Split never writes. null = Unscheduled.',
    ),
  explicitIterationName: z.string().nullable(),
  defaultSide: SplitSideSchema.describe('BR-15 — always continued'),
});

export const SplitPreviewTestCaseSchema = z.object({
  id: z.string().uuid(),
  testCaseKey: z.string(),
  name: z.string().describe('test_cases.name'),
  type: z.string().describe('Text SNAPSHOT of the Type name — survives the Type being archived'),
  lastVerdict: z
    .string()
    .nullable()
    .describe(
      'Trigger-maintained. null is a fact ("no Result yet"), rendered as Not Run — never 0.',
    ),
  defaultSide: SplitSideSchema.describe('BR-15 — always continued'),
});

export const SplitPreviewResponseSchema = z.object({
  eligible: z.boolean().describe('The ONLY field the UI branches on (SRS §11).'),
  ineligibleReason: SplitIneligibleReasonSchema.nullable(),
  story: SplitPreviewStorySchema,
  targets: z
    .array(SplitPreviewTargetSchema)
    .describe('BR-05 — the valid targets, EARLIEST FIRST. Exactly the set the write path accepts.'),
  defaults: SplitPreviewDefaultsSchema,
  tasks: z.array(SplitPreviewTaskSchema),
  defects: z.array(SplitPreviewDefectSchema),
  testCases: z.array(SplitPreviewTestCaseSchema),
});

export class SplitPreviewResponseDto extends createZodDto(SplitPreviewResponseSchema) {}

export type SplitPreviewResponseDtoShape = z.infer<typeof SplitPreviewResponseSchema>;

// ── The write half (SU-06) ────────────────────────────────────────────────────

/** One side's editable fields. `planEstimate: null` is legal and is NOT `0` (an unpointed Story). */
const SplitSideTitleSchema = z.string().trim().min(1).max(255);
const SplitSidePlanEstimateSchema = z
  .number()
  .min(0)
  .nullable()
  .describe('Plan Estimate (story points). null = unpointed, which is NOT 0.');

/**
 * `POST /work-items/:id/split`.
 *
 * **The body names the `[Unfinished]` side ONLY.** The server derives `[Continued]` as the complement
 * of the Story's live children, because a request that named both sides would let a client silently
 * drop a child added after the modal opened — it would appear in neither list and simply stay where it
 * was. An id that belongs to no live child is a 412 `SPLIT_ITEM_NOT_IN_STORY`, never a silent skip.
 *
 * `expectedSourceIterationId` is D9's optimistic guard, not decoration: `work_items` has no version
 * column, so the client echoes the source Iteration it RENDERED and the server refuses
 * `SPLIT_SOURCE_ITERATION_CHANGED` if the Story has moved since. Two concurrent confirms of the same
 * modal would otherwise both mint a placeholder.
 *
 * The three id arrays have **no `.max()`**, deliberately: the preview caps each collection at 100 and
 * a body cannot legitimately exceed what the preview offered, so a length rule here would be a second
 * limit to keep in step with that one. Membership is the real constraint, and the service enforces it
 * against live rows.
 */
export const SplitWorkItemSchema = z.object({
  expectedSourceIterationId: z
    .string()
    .uuid()
    .describe('D9 — the source Iteration the client rendered. A mismatch is a 412.'),
  targetIterationId: z
    .string()
    .uuid()
    .describe('BR-05 — must be one of the preview `targets`; the write re-checks with the same rule.'),
  unfinished: z.object({
    title: SplitSideTitleSchema,
    planEstimate: SplitSidePlanEstimateSchema,
  }),
  continued: z.object({
    title: SplitSideTitleSchema,
    planEstimate: SplitSidePlanEstimateSchema,
    releaseId: z.string().uuid().nullable(),
    scheduleState: z.enum(workItemScheduleStateEnum.enumValues),
  }),
  unfinishedTaskIds: z.array(z.string().uuid()),
  unfinishedDefectIds: z.array(z.string().uuid()),
  unfinishedTestCaseIds: z.array(z.string().uuid()),
});

export class SplitWorkItemDto extends createZodDto(SplitWorkItemSchema) {}

/**
 * The Split Event as the client sees it (SU-BR-29/30) — enough for SU-07's banner to name both sides
 * and both Iterations without a second round trip.
 *
 * `splitAt`/`createdAt` are `z.string().datetime()`; the two marker dates are `date` columns and stay
 * plain `z.string()` (`YYYY-MM-DD`), for the reason in this file's header.
 */
export const StorySplitSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  teamId: z.string().nullable(),
  continuedStoryId: z.string().uuid().describe('SU-BR-08 — the ORIGINAL Story id, unchanged.'),
  unfinishedStoryId: z.string().uuid().describe('SU-BR-07 — the new placeholder.'),
  sourceIterationId: z.string().uuid(),
  targetIterationId: z.string().uuid(),
  splitAt: z.string().datetime(),
  sourceMarkerDate: z.string().describe('ISO date YYYY-MM-DD, clamped into the source window.'),
  targetMarkerDate: z.string().describe('ISO date YYYY-MM-DD, clamped into the target window.'),
  originalPlanEstimate: z.number().nullable(),
  unfinishedPlanEstimate: z.number().nullable(),
  continuedPlanEstimate: z.number().nullable(),
  movedTodoHours: z.number().describe('Σ To Do of the Tasks that went to [Continued].'),
  actualHoursAtSplit: z.number().describe('Σ Actual across ALL distributed Tasks.'),
  actorId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

/**
 * 201's body: the Event and BOTH Stories.
 *
 * Both Stories, not just the new one, because the client has to update two things — the row it came
 * from (now `[Continued]`, in a different Iteration) and the placeholder it did not have — and a
 * response naming one of them would force a refetch to learn the other.
 */
export const SplitWorkItemResponseSchema = z.object({
  split: StorySplitSchema,
  unfinished: WorkItemResponseSchema,
  continued: WorkItemResponseSchema,
});

export class SplitWorkItemResponseDto extends createZodDto(SplitWorkItemResponseSchema) {}

export type SplitWorkItemResponseDtoShape = z.infer<typeof SplitWorkItemResponseSchema>;
