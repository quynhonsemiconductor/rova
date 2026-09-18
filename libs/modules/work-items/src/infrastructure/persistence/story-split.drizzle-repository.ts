import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@platform';
import type { DbExecutor, DrizzleDB } from '@platform';

import { storySplitItems, storySplits } from '../../../../../../db/schema/work';
import type { IStorySplitRepository } from '../../domain/ports/story-split.repository';
import type {
  CreateStorySplitInput,
  CreateStorySplitItemInput,
  StorySplit,
} from '../../domain/story-split.types';

/**
 * `work.story_splits` + `work.story_split_items`.
 *
 * Drizzle maps `numeric` to a STRING in both directions, so the conversion lives here and nowhere
 * else: numbers in, numbers out, and `null` preserved as `null` rather than collapsing to `0`. A
 * reader that did its own `Number(...)` would be the second place the wire format is decided, and
 * `Number(null)` is `0` — which is how "unpointed" becomes "worth nothing".
 */
@Injectable()
export class StorySplitDrizzleRepository implements IStorySplitRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Insert the Split Event and its distribution.
   *
   * `executor` is REQUIRED (not `executor = this.db`): both inserts belong to the Split transaction,
   * and a default would let a caller write half a Split on the pool connection. The items go in as
   * ONE multi-row insert — one round trip, and it cannot half-succeed.
   */
  async create(
    split: CreateStorySplitInput,
    items: CreateStorySplitItemInput[],
    executor: DbExecutor,
  ): Promise<StorySplit> {
    const [row] = await executor
      .insert(storySplits)
      .values({
        id: split.id,
        workspaceId: split.workspaceId,
        projectId: split.projectId,
        teamId: split.teamId,
        continuedStoryId: split.continuedStoryId,
        unfinishedStoryId: split.unfinishedStoryId,
        sourceIterationId: split.sourceIterationId,
        targetIterationId: split.targetIterationId,
        splitAt: split.splitAt,
        sourceMarkerDate: split.sourceMarkerDate,
        targetMarkerDate: split.targetMarkerDate,
        originalPlanEstimate: numericOrNull(split.originalPlanEstimate),
        unfinishedPlanEstimate: numericOrNull(split.unfinishedPlanEstimate),
        continuedPlanEstimate: numericOrNull(split.continuedPlanEstimate),
        movedTodoHours: String(split.movedTodoHours),
        actualHoursAtSplit: String(split.actualHoursAtSplit),
        actorId: split.actorId,
      })
      .returning();

    if (items.length > 0) {
      await executor.insert(storySplitItems).values(
        items.map((item) => ({
          id: item.id,
          workspaceId: item.workspaceId,
          splitId: item.splitId,
          itemKind: item.itemKind,
          taskId: item.taskId,
          workItemId: item.workItemId,
          testCaseId: item.testCaseId,
          splitSide: item.splitSide,
          estimateHoursAtSplit: numericOrNull(item.estimateHoursAtSplit),
          todoHoursAtSplit: numericOrNull(item.todoHoursAtSplit),
          actualHoursAtSplit: numericOrNull(item.actualHoursAtSplit),
          explicitIterationId: item.explicitIterationId,
        })),
      );
    }

    return toStorySplit(row);
  }
}

/** `numeric` takes a string; `null` stays `null` and must not become `'0'`. */
function numericOrNull(value: number | null): string | null {
  return value === null ? null : String(value);
}

/** The reverse: `numeric` arrives as a string, and `null` is a fact rather than a zero. */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toStorySplit(row: typeof storySplits.$inferSelect): StorySplit {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    teamId: row.teamId,
    continuedStoryId: row.continuedStoryId,
    unfinishedStoryId: row.unfinishedStoryId,
    sourceIterationId: row.sourceIterationId,
    targetIterationId: row.targetIterationId,
    splitAt: row.splitAt.toISOString(),
    sourceMarkerDate: row.sourceMarkerDate,
    targetMarkerDate: row.targetMarkerDate,
    originalPlanEstimate: numberOrNull(row.originalPlanEstimate),
    unfinishedPlanEstimate: numberOrNull(row.unfinishedPlanEstimate),
    continuedPlanEstimate: numberOrNull(row.continuedPlanEstimate),
    movedTodoHours: Number(row.movedTodoHours),
    actualHoursAtSplit: Number(row.actualHoursAtSplit),
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}
