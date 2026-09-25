import { activityEntityTypeEnum } from '../../../../../db/schema/enums';
/**
 * Shared activity-log (Revision History) domain types — one definition for every
 * entity (work item, task, attachment, iteration, project, milestone, release).
 */

/**
 * DERIVED from the database enum rather than re-listed, so the two cannot drift.
 *
 * They had drifted the moment `portfolio_item` was added by 0081: the column accepted the
 * value while this union did not, which the repository surfaced as a type error on its own
 * return. Deriving it means the next subject is a one-line change in one place.
 */
export type ActivityEntityType = (typeof activityEntityTypeEnum.enumValues)[number];

/**
 * A single field change.
 *
 * A rich-text field records a bounded plain-text PREVIEW of each side (`richTextPreview`,
 * `activity-diff.ts`) — never the markup, never the whole document. `null` on a side means that
 * side was genuinely empty, which is what lets the UI say "(empty)" and be believed (DE-18).
 */
export interface ActivityChange {
  field: string;
  old: unknown;
  new: unknown;
}

/** Input for one appended entry. */
export interface CreateActivityInput {
  id: string;
  workspaceId: string;
  projectId: string;
  entityType: ActivityEntityType;
  entityId: string;
  /** Optional parent anchor — a parent's history also returns rows anchored here
   *  (e.g. task/attachment logs anchored to the parent work item). */
  contextId?: string | null;
  actorId: string | null;
  action: string;
  changes: ActivityChange | null;
  metadata?: Record<string, unknown>;
}

/** One row as returned to the UI (actorName resolved via LEFT JOIN users). */
export interface ActivityLog {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: string;
  changes: ActivityChange | null;
  metadata: Record<string, unknown> | null;
}

export interface ActivityPage {
  data: ActivityLog[];
  total: number;
  page: number;
  pageSize: number;
}
