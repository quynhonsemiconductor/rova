/**
 * The Split Event, as the domain sees it (Phase 7 Split plan D5, migration 0131).
 *
 * `work.story_splits` + `work.story_split_items` are one aggregate: a Split is meaningless without
 * its distribution, and nothing ever writes an item row without a parent row in the same
 * transaction. That is why the repository takes both halves in a single `create` call rather than
 * exposing an `addItem`.
 *
 * NUMBERS, NOT STRINGS, at this boundary. Drizzle returns `numeric` as a string and the wire
 * contract is a JSON number, so the conversion happens once — in the repository — instead of in
 * every reader. `null` survives the round trip and is NOT `0`: an unpointed Story has no estimate,
 * and a Task with no logged Actual has not logged zero hours.
 */
import type {
  StorySplitItemKind,
  StorySplitSide,
  WorkItemScheduleState,
} from '../../../../../db/schema/enums';
import type { WorkItem } from './work-item.types';

/** One row of `work.story_splits`. */
export interface StorySplit {
  id: string;
  workspaceId: string;
  projectId: string;
  teamId: string | null;
  /** SU-BR-08 — the ORIGINAL Story, updated in place and moved to the target. */
  continuedStoryId: string;
  /** SU-BR-07 — the NEW placeholder, left behind in the source Iteration. */
  unfinishedStoryId: string;
  sourceIterationId: string;
  targetIterationId: string;
  /** ISO 8601. `[Unfinished].accepted_date` is derived from this (SU-BR-09). */
  splitAt: string;
  /** `YYYY-MM-DD`, clamped into each iteration's window — the burndown marker x-positions. */
  sourceMarkerDate: string;
  targetMarkerDate: string;
  originalPlanEstimate: number | null;
  unfinishedPlanEstimate: number | null;
  continuedPlanEstimate: number | null;
  movedTodoHours: number;
  actualHoursAtSplit: number;
  actorId: string | null;
  createdAt: string;
}

/**
 * One distributed child. Exactly one of `taskId` / `workItemId` / `testCaseId` is set, and which one
 * agrees with `itemKind` — enforced by `ck_ssi_subject_matches_kind`, not by hope.
 */
export interface StorySplitItem {
  id: string;
  workspaceId: string;
  splitId: string;
  itemKind: StorySplitItemKind;
  taskId: string | null;
  workItemId: string | null;
  testCaseId: string | null;
  splitSide: StorySplitSide;
  /** Tasks only — the per-item effort SNAPSHOT SU-10's attribution arithmetic reads. */
  estimateHoursAtSplit: number | null;
  todoHoursAtSplit: number | null;
  actualHoursAtSplit: number | null;
  /** Defects only — the Iteration the Split did NOT touch (SU-BR-18). */
  explicitIterationId: string | null;
  createdAt: string;
}

/**
 * What a Story's own detail page needs to trace its Split (SU-07, SRS §11).
 *
 * The banner reads THIS and nothing else: `Split · {source} → {target}` plus a link to each side. It
 * is deliberately not the whole {@link StorySplit} — the effort snapshot and the marker dates belong
 * to the report layer, and a detail response that carried them would advertise numbers no surface on
 * that page explains.
 *
 * `role` says which side the REQUESTED Story is on. It is derivable by comparing ids, but the server
 * derives it once for the same reason it decides `defaultSide`: the rule lives in one place, and the
 * browser is told the answer rather than re-deriving it.
 *
 * Iteration names are NULLABLE even though both FKs are `not null` — a name comes from a LEFT JOIN,
 * and a deleted iteration must degrade the banner rather than remove the trace.
 */
export interface StorySplitLink {
  splitId: string;
  /** ISO 8601 — the Split instant, so the banner can be ordered against the revision history. */
  splitAt: string;
  role: StorySplitSide;
  sourceIterationId: string;
  sourceIterationName: string | null;
  targetIterationId: string;
  targetIterationName: string | null;
  unfinished: StorySplitSideRef;
  continued: StorySplitSideRef;
}

/** One end of a Split, named the way every other work-item payload names a Story. */
export interface StorySplitSideRef {
  id: string;
  itemKey: string;
  title: string;
}

/**
 * What the two RECORD reads return — the row, plus the Split trace folded into it (§8 Q15).
 *
 * A pair rather than a widened {@link WorkItem}: the split link is not a column of the work item and
 * nothing writes it, so putting it on the row type would offer it to every `update` payload and every
 * grid mapper that spreads a row. The controller composes the two into one JSON object.
 */
export interface WorkItemDetail {
  item: WorkItem;
  splitLink: StorySplitLink | null;
}

/** What the service hands the repository for the parent row. `id` is minted by the caller (uuidv7). */
export type CreateStorySplitInput = Omit<StorySplit, 'splitAt' | 'createdAt'> & {
  /** Explicit rather than defaulted, because `[Unfinished].accepted_date` must equal it exactly. */
  splitAt: Date;
};

/** What the service hands the repository per distributed child. */
export type CreateStorySplitItemInput = Omit<StorySplitItem, 'createdAt'>;

// ── The write ─────────────────────────────────────────────────────────────────

/**
 * `POST /work-items/:id/split`'s body, at the service boundary (plan §3.2).
 *
 * THE REQUEST NAMES THE `[Unfinished]` SIDE ONLY and the server derives `[Continued]` as the
 * COMPLEMENT of the Story's LIVE children. A request that named both sides would let a client
 * silently drop a child added after the modal opened — it would simply appear in neither list — and
 * an id that belongs to no live child is a refusal (`SPLIT_ITEM_NOT_IN_STORY`), never a silent skip.
 *
 * `planEstimate: null` is legal on either side and is NOT `0`: an unpointed Story has no estimate.
 */
export interface SplitWorkItemInput {
  /** D9's optimistic guard: the source Iteration the CLIENT rendered. */
  expectedSourceIterationId: string;
  targetIterationId: string;
  unfinished: { title: string; planEstimate: number | null };
  continued: {
    title: string;
    planEstimate: number | null;
    releaseId: string | null;
    scheduleState: WorkItemScheduleState;
  };
  unfinishedTaskIds: string[];
  unfinishedDefectIds: string[];
  unfinishedTestCaseIds: string[];
}

/** Both Stories and the Event that connects them (SU-BR-29/30). */
export interface SplitWorkItemResult {
  split: StorySplit;
  unfinished: WorkItem;
  continued: WorkItem;
}
