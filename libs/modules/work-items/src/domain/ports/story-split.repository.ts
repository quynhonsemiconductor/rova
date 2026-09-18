import type { DbExecutor } from '@platform';
import type {
  CreateStorySplitInput,
  CreateStorySplitItemInput,
  StorySplit,
} from '../story-split.types';

export const STORY_SPLIT_REPOSITORY = Symbol('STORY_SPLIT_REPOSITORY');

/**
 * The Split Event's persistence port.
 *
 * ONE METHOD, deliberately. The plan's §6 6.2 lists five (`create`, `findByStoryId`,
 * `findBySourceIteration`, `findByTargetIteration`, `findTaskSnapshots`), but four of them have no
 * caller until SU-07 (the banner) and SU-08/09/10 (the reports). A port method with no consumer is
 * dead code of exactly the kind SU-01 deleted under 1.2 — untested, unexercised, and shaped by a
 * guess about what its future caller will want. **They land with their consumers.** Note that the
 * SU-06 e2e asserts the stored rows with raw SQL rather than through a read method, which is the
 * stronger assertion anyway: it cannot pass because a repository and a service agree with each other.
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
}
