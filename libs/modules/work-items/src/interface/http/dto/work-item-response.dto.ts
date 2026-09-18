import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SPLIT_SIDES } from '../../../application/split-story';

export const WorkItemResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  itemKey: z.string().describe('Sequential key e.g. PROJ-42'),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  statusId: z.string().uuid(),
  scheduleState: z.string(),
  flowState: z.string(),
  priority: z.string(),
  assigneeId: z.string().uuid().nullable(),
  assigneeName: z
    .string()
    .nullable()
    .describe(
      'Owner display name, joined server-side on the grid reads. A picker feed cannot name a ' +
        'Workspace Admin (no project_members row, §2.1), so the row carries its own name.',
    ),
  devOwnerName: z.string().nullable(),
  reporterId: z.string().uuid().nullable(),
  parentId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  iterationId: z.string().uuid().nullable(),
  releaseId: z.string().uuid().nullable(),
  featureId: z
    .string()
    .uuid()
    .nullable()
    .describe('The Feature this item rolls up to. Always null for a task.'),
  storyPoints: z.number().nullable(),
  estimateHours: z.number().nullable(),
  todoHours: z.number().nullable(),
  actualHours: z.number().nullable(),
  acceptanceCriteria: z.string().nullable(),
  notes: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  isBlocked: z.boolean(),
  blockedReason: z.string().nullable(),
  rank: z.string(),
  customFields: z.record(z.string(), z.unknown()),
  createdBy: z.string().uuid(),
  updatedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // P3.4 — Defect-specific fields
  severity: z.string().nullable(),
  foundInEnvironment: z.string().nullable(),
  foundInReleaseId: z.string().uuid().nullable(),
  rootCause: z.string().nullable(),
  resolution: z.string().nullable(),
  devOwnerId: z.string().uuid().nullable(),
  defectState: z.string().nullable(),
  fixedInBuild: z.string().nullable(),
});

export class WorkItemResponseDto extends createZodDto(WorkItemResponseSchema) {}

export type WorkItemResponseDtoShape = z.infer<typeof WorkItemResponseSchema>;

// ── The RECORD reads: the row plus its Split trace (Phase 7 SU-07, §8 Q15) ───

/**
 * One end of a Split, as the banner links to it.
 *
 * `title` rides along so the link can carry a real accessible name — `US-42` alone tells a screen
 * reader nothing about where it goes, and the alternative is a second request per side.
 */
const SplitLinkSideSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
});

/**
 * `Split · {source} → {target}`, with a link to each resulting Story (SRS §11, SU-BR-30).
 *
 * FOLDED INTO THE RECORD READS rather than given its own route (§8 Q15): the detail page already
 * fetches the Story, and a second request for a one-line bar is a render-blocking round trip for data
 * in the same aggregate. Additive, so the `openapi` breaking-change diff stays clean.
 *
 * `role` says which side the REQUESTED Story is — the banner marks it as the current page instead of
 * offering a link back to itself. Derivable by comparing ids, and derived ONCE, on the server, for the
 * same reason `defaultSide` is. Its members come from `SPLIT_SIDES` (which is
 * `storySplitSideEnum.enumValues`), never re-typed here — the rule SU-01's review set, and the reason
 * `split-work-item.dto.ts` reads the same array.
 *
 * Iteration names are nullable: they come from a join, and a deleted Iteration must degrade the bar
 * rather than delete the trace. Both Stories are non-null by construction — the repository returns no
 * link at all unless both ends are live, because a link that cannot be followed is worse than none.
 */
const SplitLinkSchema = z.object({
  splitId: z.string().uuid(),
  splitAt: z.string().datetime(),
  role: z.enum(SPLIT_SIDES),
  sourceIterationId: z.string().uuid(),
  sourceIterationName: z.string().nullable(),
  targetIterationId: z.string().uuid(),
  targetIterationName: z.string().nullable(),
  unfinished: SplitLinkSideSchema,
  continued: SplitLinkSideSchema,
});

/**
 * `GET /work-items/:id` and `GET /work-items/by-key` — the record, and ONLY the record.
 *
 * An `.extend()` of {@link WorkItemResponseSchema} rather than a field ON it, because that schema also
 * answers `GET /work-items`, `/backlog` and `/:id/tasks`: a grid row would then advertise a
 * `splitLink` that is always `null`, which is a contract that lies about what the list knows. The
 * record reads are where a Story's own relationships belong — the same boundary `StoryOptionSchema`
 * draws from the other side.
 *
 * BOTH record routes, because the detail page resolves by KEY (`/item/$itemKey` carries no id). Q15's
 * wording names `:id` alone; its reasoning ("the detail page already fetches the Story") is what makes
 * `by-key` the route that actually had to carry it.
 */
export const WorkItemDetailResponseSchema = WorkItemResponseSchema.extend({
  splitLink: SplitLinkSchema.nullable().describe(
    'The Split this Story takes part in, from either side. Null when it was never split — which ' +
      'includes every Task and Defect, since only a Story can be split.',
  ),
});

export class WorkItemDetailResponseDto extends createZodDto(WorkItemDetailResponseSchema) {}

export type WorkItemDetailResponseDtoShape = z.infer<typeof WorkItemDetailResponseSchema>;

// ── Task totals (Tasks-tab totals row) ──────────────────────────────────────

export const TaskTotalsResponseSchema = z.object({
  taskCount: z.number().int(),
  estimateHours: z.number(),
  todoHours: z.number(),
  actualHours: z.number(),
});

export class TaskTotalsResponseDto extends createZodDto(TaskTotalsResponseSchema) {}

// ── Home dashboard aggregates ────────────────────────────────────────────────

export const MyWorkItemResponseSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  type: z.string(),
  title: z.string(),
  scheduleState: z.string(),
  priority: z.string(),
  projectId: z.string().uuid(),
  projectKey: z.string(),
  projectName: z.string(),
});

export class MyWorkItemResponseDto extends createZodDto(MyWorkItemResponseSchema) {}

export const WorkspaceSummaryResponseSchema = z.object({
  activeProjects: z.number().int().min(0),
  openWorkItems: z.number().int().min(0),
  activeSprints: z.number().int().min(0),
  blockedItems: z.number().int().min(0),
  openDefects: z.number().int().min(0),
  assignedToMe: z.number().int().min(0),
});

export class WorkspaceSummaryResponseDto extends createZodDto(WorkspaceSummaryResponseSchema) {}

// ── Activity (Revision History) ─────────────────────────────────────────────

export const ActivityResponseSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  actorId: z.string().uuid().nullable(),
  /** Display name of the actor, resolved server-side. */
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  changes: z.object({ field: z.string(), old: z.unknown(), new: z.unknown() }).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export class ActivityResponseDto extends createZodDto(ActivityResponseSchema) {}

export type ActivityResponseDtoShape = z.infer<typeof ActivityResponseSchema>;

// ── Time log ──────────────────────────────────────────────────────────────────

export const TimeLogResponseSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  userId: z.string().uuid(),
  loggedDate: z.string().describe('ISO date YYYY-MM-DD'),
  hours: z.number().describe('Hours logged (positive, max 24)'),
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class TimeLogResponseDto extends createZodDto(TimeLogResponseSchema) {}

export type TimeLogResponseDtoShape = z.infer<typeof TimeLogResponseSchema>;

// ── Watcher ───────────────────────────────────────────────────────────────────

export const WatcherResponseSchema = z.object({
  userId: z.string().uuid(),
  watchedAt: z.string().datetime(),
});

export class WatcherResponseDto extends createZodDto(WatcherResponseSchema) {}

// ── Parent Story reference feed ───────────────────────────────────────────────

/**
 * The Story REFERENCE feed's row — the picker behind a Defect's `Parent Story` field.
 *
 * A separate schema, not a `.pick()` of {@link WorkItemResponseSchema}, for the same reason
 * `PortfolioFeatureOptionSchema` is: a field added to the record shape must not silently join a
 * feed that a wider audience reads.
 */
export const StoryOptionSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string().describe('US-<n>, unique across the workspace'),
  title: z.string(),
  projectId: z.string().uuid().describe('Always the requested project; echoed for binding'),
});

export class StoryOptionResponseDto extends createZodDto(StoryOptionSchema) {}

export type StoryOptionResponseDtoShape = z.infer<typeof StoryOptionSchema>;
