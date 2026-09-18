import type { DbExecutor } from '@platform';
import type {
  CreateStorySplitInput,
  CreateStorySplitItemInput,
  StorySplit,
  StorySplitLink,
} from '../story-split.types';

export const STORY_SPLIT_REPOSITORY = Symbol('STORY_SPLIT_REPOSITORY');

/**
 * The Split Event's persistence port.
 *
 * TWO METHODS, and the count is the point. The plan's §6 6.2 lists five (`create`, `findByStoryId`,
 * `findBySourceIteration`, `findByTargetIteration`, `findTaskSnapshots`); SU-06 landed `create` alone
 * because the other four had no caller, and a port method with no consumer is dead code of exactly
 * the kind SU-01 deleted under 1.2 — untested, unexercised, and shaped by a guess about what its
 * future caller will want. **They land with their consumers.** SU-07's banner is `findByStoryId`'s
 * consumer, so it lands here; the two iteration lookups the burndown needs are on
 * `IReportingRepository` instead (SU-08), because `@modules/reporting` does not import
 * `@modules/work-items` and one banner is not a reason to make it.
 *
 * `create` takes BOTH halves because they are one aggregate — nothing may write an item row without
 * its parent row in the same transaction — and it REQUIRES an executor rather than defaulting to the
 * pool: a Split Event that could be written outside the Split transaction is a partial Split waiting
 * to happen.
 */
export interface IStorySplitRepository {
  create(
    split: CreateStorySplitInput,
    items: CreateStorySplitItemInput[],
    executor: DbExecutor,
  ): Promise<StorySplit>;

  /**
   * The Split this Story takes part in, from EITHER side (SU-07 7.1) — `null` when it takes part in
   * none, which is every Story that was never split.
   *
   * ONE row, the most recent by `split_at`. A Story can be the `[Unfinished]` placeholder of exactly
   * one Split (`uq_story_splits_unfinished`) but the `[Continued]` side of many, because a Story
   * carried forward may be split again in the next Iteration — so the banner names the LATEST hop of
   * the chain. That is a known narrowing of a re-split chain to its newest link, recorded in the plan
   * rather than left for a reader to discover from the ORDER BY.
   */
  findByStoryId(storyId: string, workspaceId: string): Promise<StorySplitLink | null>;
}
