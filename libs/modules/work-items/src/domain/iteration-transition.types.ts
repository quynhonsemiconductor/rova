import type { IterationTransitionType, TaskState } from '../../../../../db/schema/enums';
import type { WorkItem } from './work-item.types';

/**
 * One user-initiated Story Iteration change (Phase 7 Carryover, plan D3) — a confirmed `carryover`
 * or a `manual_move` (ruling R8). Immutable once written (CO-BR-46).
 *
 * Ids only (CO-BR-45): the display names live in the activity entry's metadata.
 */
export interface IterationTransition {
  id: string;
  workspaceId: string;
  projectId: string;
  /** The Story's team AT THE MOVE. */
  teamId: string | null;
  storyId: string;
  type: IterationTransitionType;
  sourceIterationId: string | null;
  targetIterationId: string | null;
  /** `YYYY-MM-DD`; set on a Carryover, null on a Manual Move. */
  targetEndDate: string | null;
  actorId: string | null;
  occurredAt: string;
  createdAt: string;
}

export type CreateIterationTransitionInput = Omit<
  IterationTransition,
  'createdAt' | 'occurredAt'
> & {
  occurredAt: Date;
};

/** The per-Task snapshot at a Carryover (CO-BR-30). Hours are numbers; `null` is "unset", never 0. */
export interface CreateIterationTransitionTaskInput {
  id: string;
  workspaceId: string;
  transitionId: string;
  taskId: string;
  state: TaskState;
  estimateHoursAtMove: number | null;
  todoHoursAtMove: number | null;
  actualHoursAtMove: number | null;
}

/** `POST /work-items/:id/carryover`'s body, after validation. */
export interface CarryOverWorkItemInput {
  /** D6 — the source Iteration the modal rendered; a mismatch is a 412. */
  expectedSourceIterationId: string;
  targetIterationId: string;
  /** `YYYY-MM-DD`. */
  targetEndDate: string;
}

export interface CarryOverWorkItemResult {
  transition: IterationTransition;
  workItem: WorkItem;
}

/** One Iteration as the Target End picker sees it. */
export interface CarryoverOptionIteration {
  id: string;
  name: string;
  iterationKey: string | null;
  state: string;
  startDate: string;
  endDate: string;
  teamId: string | null;
}

/** `GET /work-items/:id/carryover-options` (plan D8). The SPA consumes this; it decides nothing. */
export interface CarryoverOptions {
  /** Caller can edit AND the Story is scheduled AND something is eligible. */
  editable: boolean;
  storyStartDate: string | null;
  targetEndDate: string | null;
  current:
    | (Omit<CarryoverOptionIteration, 'teamId' | 'startDate' | 'endDate'> & {
        startDate: string | null;
        endDate: string | null;
        eligible: boolean;
      })
    | null;
  minDate: string | null;
  eligibleIterations: CarryoverOptionIteration[];
  taskCount: number;
  unfinishedTaskCount: number;
}
