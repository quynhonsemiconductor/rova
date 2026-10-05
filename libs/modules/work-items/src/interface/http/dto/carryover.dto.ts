import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { iterationTransitionTypeEnum } from '../../../../../../../db/schema/enums';
import { isoDate } from './work-item-request.dto';
import { WorkItemResponseSchema } from './work-item-response.dto';

/**
 * Phase 7 Story Target End Date + Carryover (plan D6/D8).
 *
 * Every date here is a `date` column or a calendar day — plain `z.string()`, NEVER `.datetime()`,
 * which rejects a bare `YYYY-MM-DD`. Timestamps (`occurredAt`, `createdAt`) are `.datetime()`.
 */

// ── GET /work-items/:id/carryover-options ────────────────────────────────────

const CarryoverOptionIterationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  iterationKey: z.string().nullable(),
  state: z.string(),
  startDate: z.string().describe('YYYY-MM-DD'),
  endDate: z.string().describe('YYYY-MM-DD'),
  teamId: z.string().uuid().nullable(),
});

export const CarryoverOptionsResponseSchema = z.object({
  editable: z
    .boolean()
    .describe('The caller may edit, the Story is scheduled, and some Iteration is eligible.'),
  storyStartDate: z.string().nullable(),
  targetEndDate: z.string().nullable(),
  current: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      iterationKey: z.string().nullable(),
      state: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      eligible: z.boolean().describe('False for an accepted current Iteration (ruling R6).'),
    })
    .nullable()
    .describe('The Story’s current Iteration; null when Unscheduled.'),
  minDate: z.string().nullable().describe('CO-BR-13/14 — the earliest selectable date.'),
  eligibleIterations: z
    .array(CarryoverOptionIterationSchema)
    .describe('Ordered by start date then name. A date is enabled when one of these contains it.'),
  taskCount: z.number().int(),
  unfinishedTaskCount: z.number().int(),
});

export class CarryoverOptionsResponseDto extends createZodDto(CarryoverOptionsResponseSchema) {}

// ── POST /work-items/:id/carryover ───────────────────────────────────────────

export const CarryOverWorkItemSchema = z.object({
  expectedSourceIterationId: z
    .string()
    .uuid()
    .describe('D6 — the source Iteration the modal rendered. A mismatch is a 412.'),
  targetIterationId: z
    .string()
    .uuid()
    .describe('Must be one of the Iterations the Target End Date resolves to.'),
  targetEndDate: isoDate.describe('YYYY-MM-DD, after the source Iteration ends.'),
});

export class CarryOverWorkItemDto extends createZodDto(CarryOverWorkItemSchema) {}

export const IterationTransitionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  teamId: z.string().uuid().nullable(),
  storyId: z.string().uuid(),
  type: z.enum(iterationTransitionTypeEnum.enumValues),
  sourceIterationId: z.string().uuid().nullable(),
  targetIterationId: z.string().uuid().nullable(),
  targetEndDate: z.string().nullable(),
  actorId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const CarryOverWorkItemResponseSchema = z.object({
  transition: IterationTransitionSchema,
  workItem: WorkItemResponseSchema,
});

export class CarryOverWorkItemResponseDto extends createZodDto(CarryOverWorkItemResponseSchema) {}
