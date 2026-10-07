import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workItemTypeEnum, workItemScheduleStateEnum } from '../../../../../../../db/schema/enums';

export const IterationStatusMetricsSchema = z.object({
  /** Null when the iteration has NO velocity target — see the service. */
  plannedVelocityPercent: z.number().int().nullable(),
  acceptedPoints: z.number(),
  /** Null when no target was set. `iterations.planned_velocity` is nullable. */
  plannedVelocity: z.number().int().nullable(),
  acceptedPercent: z.number().int(),
  totalPlanEstimate: z.number(),
  daysLeft: z.number().int().nullable(),
  defectCount: z.number().int(),
  taskCount: z.number().int(),
  activeTaskCount: z.number().int(),
});

export const IterationStatusItemSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  type: z.enum(workItemTypeEnum.enumValues),
  title: z.string(),
  scheduleState: z.enum(workItemScheduleStateEnum.enumValues),
  iterationId: z.string().uuid().nullable(),
  // The row's Team — the scope of its Owner / Dev Owner candidate list (`WID-FR-017`).
  teamId: z.string().uuid().nullable(),
  isBlocked: z.boolean(),
  blockedReason: z.string().nullable(),
  planEstimate: z.number().nullable(),
  taskEstimate: z.number(),
  toDo: z.number(),
  actual: z.number(),
  taskTotal: z.number().int(),
  taskDone: z.number().int(),
  assigneeId: z.string().uuid().nullable(),
  assigneeName: z
    .string()
    .nullable()
    .describe(
      'Owner display name, joined server-side — a picker feed cannot name a Workspace Admin',
    ),
  devOwnerId: z.string().uuid().nullable(),
  devOwnerName: z.string().nullable(),
  rank: z.string(),
  featureId: z.string().uuid().nullable(),
  featureKey: z.string().nullable(),
  featureTitle: z.string().nullable(),
  defectCount: z.number().int(),
  openDefectCount: z.number().int(),
  milestones: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  // Phase 7 Carryover (CO-01 / CO-03) — `YYYY-MM-DD`, Story only.
  startDate: z.string().nullable(),
  targetEndDate: z.string().nullable(),
});

export const IterationSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  iterationKey: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  plannedVelocity: z.number().int().nullable(),
});

export const IterationStatusResponseSchema = z.object({
  iteration: IterationSummarySchema,
  metrics: IterationStatusMetricsSchema,
  items: z.array(IterationStatusItemSchema),
  pageInfo: z.object({
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
    limit: z.number().int(),
  }),
});

export class IterationStatusResponseDto extends createZodDto(IterationStatusResponseSchema) {}

export const CreateIterationItemResponseSchema = z.object({
  workItemId: z.string().uuid(),
  itemKey: z.string(),
});

export class CreateIterationItemResponseDto extends createZodDto(
  CreateIterationItemResponseSchema,
) {}
