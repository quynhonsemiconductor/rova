import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const TEAM_TASK_STATES = ['Defined', 'In-Progress', 'Completed'] as const;

const WorkProductSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  type: z.enum(['Story', 'Defect', 'Feature']),
  title: z.string(),
  status: z.string(),
});

const ReleaseRefSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .nullable();

const OwnerSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

const TaskRowSchema = z.object({
  id: z.string().uuid(),
  taskKey: z.string(),
  title: z.string(),
  displayName: z.string(),
  workProduct: WorkProductSchema,
  release: ReleaseRefSchema,
  state: z.enum(TEAM_TASK_STATES),
  // Nullable: `null` = never entered, not 0 (see `TeamStatusTaskRow`). Group and totals stay numbers.
  estimateHours: z.number().nullable(),
  todoHours: z.number().nullable(),
  actualHours: z.number().nullable(),
  owner: OwnerSchema,
  rank: z.string().nullable(),
});

const MemberGroupSchema = z.object({
  owner: OwnerSchema,
  capacityHours: z.number(),
  taskCount: z.number(),
  estimateHours: z.number(),
  todoHours: z.number(),
  actualHours: z.number(),
  progressPercent: z.number(),
  tasks: z.array(TaskRowSchema),
});

const TotalsSchema = z.object({
  capacityHours: z.number(),
  estimateHours: z.number(),
  todoHours: z.number(),
  actualHours: z.number(),
});

const IterationRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

export const TeamStatusResponseSchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  iteration: IterationRefSchema,
  totals: TotalsSchema,
  groups: z.array(MemberGroupSchema),
});
export class TeamStatusResponseDto extends createZodDto(TeamStatusResponseSchema) {}

// ── Capacity update response ────────────────────────────────────────────

export const CapacityResponseSchema = z.object({
  userId: z.string().uuid(),
  capacityHours: z.number(),
});
export class CapacityResponseDto extends createZodDto(CapacityResponseSchema) {}

// ── Task update response ────────────────────────────────────────────────

export const TaskUpdateResponseSchema = z.object({
  id: z.string().uuid(),
  taskKey: z.string(),
  title: z.string(),
  state: z.enum(TEAM_TASK_STATES),
  workProduct: z
    .object({
      id: z.string().uuid(),
      key: z.string(),
      status: z.string(),
    })
    .optional(),
});
export class TaskUpdateResponseDto extends createZodDto(TaskUpdateResponseSchema) {}
