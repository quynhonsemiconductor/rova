import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@platform';
import type { DbExecutor, DrizzleDB } from '@platform';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  iterations,
  storySplitItems,
  storySplits,
  workItems,
} from '../../../../../../db/schema/work';
import type { IStorySplitRepository } from '../../domain/ports/story-split.repository';
import type {
  CreateStorySplitInput,
  CreateStorySplitItemInput,
  StorySplit,
  StorySplitLink,
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

  /**
   * The Split this Story takes part in, from either side — SU-07's banner, in ONE round trip.
   *
   * Four joins rather than a second query per name: both Stories' keys and both Iterations' names are
   * needed together, and the alternative is five reads for a one-line bar on a page that is already
   * waiting for the record itself.
   *
   * THE TWO STORIES ARE `innerJoin`ed AND MUST BOTH BE LIVE; the two Iterations are `leftJoin`ed.
   * That asymmetry is the contract: a banner exists to be clicked, so a link to a soft-deleted Story
   * would offer a dead end — no row is better than half a trace. An iteration NAME, by contrast, is
   * decoration on a link that still works, so a missing one degrades to `null` and the banner renders
   * without it.
   *
   * `or(unfinished, continued)` and NOT a `union`: the two cases differ only in which column matched,
   * which `role` reports below. The workspace predicate is on `story_splits` — it is the row being
   * authorized, and every joined row is reachable only through its own FK.
   *
   * ORDER BY `split_at desc, id desc`: a Story can be the `[Continued]` side of several Splits (a
   * re-split chain), and the banner shows the newest hop. `id` is the tiebreaker that makes the order
   * TOTAL, which the query-ordering ratchet requires — two Splits committed inside the same `now()`
   * would otherwise return whichever row Postgres happened to scan first.
   */
  async findByStoryId(storyId: string, workspaceId: string): Promise<StorySplitLink | null> {
    const unfinished = alias(workItems, 'split_unfinished');
    const continued = alias(workItems, 'split_continued');
    const source = alias(iterations, 'split_source_iteration');
    const target = alias(iterations, 'split_target_iteration');

    const rows = await this.db
      .select({
        splitId: storySplits.id,
        splitAt: storySplits.splitAt,
        unfinishedStoryId: storySplits.unfinishedStoryId,
        sourceIterationId: storySplits.sourceIterationId,
        sourceIterationName: source.name,
        targetIterationId: storySplits.targetIterationId,
        targetIterationName: target.name,
        unfinishedId: unfinished.id,
        unfinishedKey: unfinished.itemKey,
        unfinishedTitle: unfinished.title,
        continuedId: continued.id,
        continuedKey: continued.itemKey,
        continuedTitle: continued.title,
      })
      .from(storySplits)
      .innerJoin(
        unfinished,
        and(eq(unfinished.id, storySplits.unfinishedStoryId), isNull(unfinished.deletedAt)),
      )
      .innerJoin(
        continued,
        and(eq(continued.id, storySplits.continuedStoryId), isNull(continued.deletedAt)),
      )
      .leftJoin(source, eq(source.id, storySplits.sourceIterationId))
      .leftJoin(target, eq(target.id, storySplits.targetIterationId))
      .where(
        and(
          eq(storySplits.workspaceId, workspaceId),
          or(eq(storySplits.unfinishedStoryId, storyId), eq(storySplits.continuedStoryId, storyId)),
        ),
      )
      .orderBy(desc(storySplits.splitAt), desc(storySplits.id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      splitId: row.splitId,
      splitAt: row.splitAt.toISOString(),
      role: row.unfinishedStoryId === storyId ? 'unfinished' : 'continued',
      sourceIterationId: row.sourceIterationId,
      sourceIterationName: row.sourceIterationName,
      targetIterationId: row.targetIterationId,
      targetIterationName: row.targetIterationName,
      unfinished: {
        id: row.unfinishedId,
        itemKey: row.unfinishedKey,
        title: row.unfinishedTitle,
      },
      continued: { id: row.continuedId, itemKey: row.continuedKey, title: row.continuedTitle },
    };
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
