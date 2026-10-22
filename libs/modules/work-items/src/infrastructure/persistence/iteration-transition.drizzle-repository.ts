import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '@platform';

import { iterationTransitionTasks, iterationTransitions } from '../../../../../../db/schema/work';
import type { IIterationTransitionRepository } from '../../domain/ports/iteration-transition.repository';
import type {
  CreateIterationTransitionInput,
  CreateIterationTransitionTaskInput,
  IterationTransition,
} from '../../domain/iteration-transition.types';

/**
 * `work.iteration_transitions` + `work.iteration_transition_tasks`.
 *
 * `numeric` is a string on the wire in both directions; `null` stays `null` and never becomes `'0'`
 * (the `story-split.drizzle-repository.ts` rule).
 */
@Injectable()
export class IterationTransitionDrizzleRepository implements IIterationTransitionRepository {
  async create(
    transition: CreateIterationTransitionInput,
    tasks: CreateIterationTransitionTaskInput[],
    executor: DbExecutor,
  ): Promise<IterationTransition> {
    const [created] = await this.createMany([transition], executor);

    // One multi-row insert: one round trip, and it cannot half-succeed.
    if (tasks.length > 0) {
      await executor.insert(iterationTransitionTasks).values(
        tasks.map((task) => ({
          id: task.id,
          workspaceId: task.workspaceId,
          transitionId: task.transitionId,
          taskId: task.taskId,
          state: task.state,
          estimateHoursAtMove: numericOrNull(task.estimateHoursAtMove),
          todoHoursAtMove: numericOrNull(task.todoHoursAtMove),
          actualHoursAtMove: numericOrNull(task.actualHoursAtMove),
        })),
      );
    }
    return created;
  }

  /**
   * Several snapshot-less transitions in ONE multi-row INSERT — a bulk Iteration assignment writes one
   * Manual Move per Story, and N sequential inserts inside a lock-holding transaction is what the
   * activity log's own `appendMany` exists to avoid.
   *
   * RETURNING is checked row-for-row. An insert can legitimately return fewer rows (a future
   * `ON CONFLICT DO NOTHING`, a BEFORE trigger returning NULL), and a missing row must fail HERE with
   * the transition id rather than as `Cannot read properties of undefined` in the caller.
   */
  async createMany(
    transitions: CreateIterationTransitionInput[],
    executor: DbExecutor,
  ): Promise<IterationTransition[]> {
    if (transitions.length === 0) return [];
    const rows = await executor
      .insert(iterationTransitions)
      .values(
        transitions.map((t) => ({
          id: t.id,
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          teamId: t.teamId,
          storyId: t.storyId,
          type: t.type,
          sourceIterationId: t.sourceIterationId,
          targetIterationId: t.targetIterationId,
          targetEndDate: t.targetEndDate,
          actorId: t.actorId,
          occurredAt: t.occurredAt,
        })),
      )
      .returning();

    const byId = new Map(rows.map((row) => [row.id, row]));
    return transitions.map((t) => {
      const row = byId.get(t.id);
      if (!row) {
        throw new Error(`iteration transition ${t.id} was not persisted (INSERT returned no row)`);
      }
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        teamId: row.teamId,
        storyId: row.storyId,
        type: row.type,
        sourceIterationId: row.sourceIterationId,
        targetIterationId: row.targetIterationId,
        targetEndDate: row.targetEndDate,
        actorId: row.actorId,
        occurredAt: row.occurredAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}

function numericOrNull(value: number | null): string | null {
  return value === null ? null : String(value);
}
