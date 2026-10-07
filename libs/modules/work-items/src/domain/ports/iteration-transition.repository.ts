import type { DbExecutor } from '@platform';
import type {
  CreateIterationTransitionInput,
  CreateIterationTransitionTaskInput,
  IterationTransition,
} from '../iteration-transition.types';

export const ITERATION_TRANSITION_REPOSITORY = Symbol('ITERATION_TRANSITION_REPOSITORY');

/**
 * `work.iteration_transitions` + `work.iteration_transition_tasks` — the write half (plan D3/D6/D9).
 *
 * WRITE-ONLY on this side, deliberately: the events are read by `@modules/reporting` (which does not
 * import this module) and by the Revision History, which reads the activity entries. A reader port
 * here would have no consumer.
 *
 * `executor` is REQUIRED: an event written outside the move's own transaction is a partial Carryover
 * (or a Manual Move recorded for a move that rolled back).
 */
export interface IIterationTransitionRepository {
  create(
    transition: CreateIterationTransitionInput,
    tasks: CreateIterationTransitionTaskInput[],
    executor: DbExecutor,
  ): Promise<IterationTransition>;
  /** Several snapshot-less transitions (Manual Moves) in one multi-row INSERT. */
  createMany(
    transitions: CreateIterationTransitionInput[],
    executor: DbExecutor,
  ): Promise<IterationTransition[]>;
}
