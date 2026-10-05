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
    const [row] = await executor
      .insert(iterationTransitions)
      .values({
        id: transition.id,
        workspaceId: transition.workspaceId,
        projectId: transition.projectId,
        teamId: transition.teamId,
        storyId: transition.storyId,
        type: transition.type,
        sourceIterationId: transition.sourceIterationId,
        targetIterationId: transition.targetIterationId,
        targetEndDate: transition.targetEndDate,
        actorId: transition.actorId,
        occurredAt: transition.occurredAt,
      })
      .returning();

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
  }
}

function numericOrNull(value: number | null): string | null {
  return value === null ? null : String(value);
}
