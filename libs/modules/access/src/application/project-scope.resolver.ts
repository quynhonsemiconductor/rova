import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { InjectDrizzle, NotFoundException } from '@platform';
import type { DrizzleDB, ErrorCode } from '@platform';
import {
  workItems,
  tasks,
  iterations,
  releases,
  milestones,
  portfolioItems,
  capacityPlans,
  testCases,
  testResults,
} from '../../../../../db/schema/work';

/**
 * Resource kinds whose project scope the PolicyGuard resolves by LOADING the row
 * (for endpoints where the project id is only reachable via `:id`, not the
 * request body/query).
 *
 * `work_item` spans TWO tables. Tasks moved out of `work_items` into `work.tasks`
 * at the Phase 3 split (migration 0072: "nothing inserts a task into work_items"),
 * but the routes did not split with them — `PATCH /work-items/:id`,
 * `/:id/activity`, `/:id/attachments`, `/:id/watchers` and
 * `PATCH /team-status/tasks/:taskId` all take a TASK's own id. So there is no
 * separate `task` kind to add: one kind has to cover both tables, exactly as
 * `WorkItemDrizzleRepository.findById` already does.
 */
export type ScopedResource =
  | 'work_item'
  | 'iteration'
  | 'release'
  | 'milestone'
  | 'portfolio_item'
  | 'capacity_plan'
  | 'test_case'
  | 'test_result';

const TABLES = {
  work_item: workItems,
  iteration: iterations,
  release: releases,
  milestone: milestones,
  // Epic and Feature share one table, so one kind covers both.
  portfolio_item: portfolioItems,
  capacity_plan: capacityPlans,
  // Distinct kinds, NOT folded into `work_item` (Phase 7 plan §3): unlike Tasks, Test Case and
  // Test Result routes are not shared with anything, so there is no reason for one kind to cover
  // two tables the way `work_item` is forced to.
  test_case: testCases,
  test_result: testResults,
} as const;

const NOT_FOUND: Record<ScopedResource, [ErrorCode, string]> = {
  work_item: ['WORK_ITEM_NOT_FOUND', 'Work item not found'],
  iteration: ['ITERATION_NOT_FOUND', 'Iteration not found'],
  release: ['RELEASE_NOT_FOUND', 'Release not found'],
  milestone: ['MILESTONE_NOT_FOUND', 'Milestone not found'],
  portfolio_item: ['PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found'],
  capacity_plan: ['CAPACITY_PLAN_NOT_FOUND', 'Capacity plan not found'],
  test_case: ['TEST_CASE_NOT_FOUND', 'Test case not found'],
  test_result: ['TEST_RESULT_NOT_FOUND', 'Test result not found'],
};

/**
 * Resolves a scoped resource's owning `projectId` for the PolicyGuard. One
 * indexed PK+workspace lookup; a missing row throws the resource's NotFound so a
 * bad id is a clean 404, not a misleading 403. Workspace-scoped in the WHERE so
 * the lookup itself can never cross tenants.
 */
@Injectable()
export class ProjectScopeResolver {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async resolve(resource: ScopedResource, id: string, workspaceId: string): Promise<string> {
    const projectId =
      (await this.lookup(TABLES[resource], id, workspaceId)) ??
      /**
       * A task's id, on a `work_item` route.
       *
       * Without this fallback the guard threw WORK_ITEM_NOT_FOUND for every task id — before the
       * handler ran, and regardless of permission. Measured as a Workspace Admin: `GET`, `/activity`
       * and `/attachments` on a task all answered 404 while the parent story answered 200. That made
       * a Task uneditable everywhere (Tasks tab, Task Detail, Team Status), its Revision History
       * permanently empty, and its attachments unreachable — four Phase 1 SRS contracts dead on one
       * line of table mapping.
       *
       * Second query, not a join or a union: the common case is a story or defect and pays nothing,
       * and only a miss reaches the tasks table. Mirrors `findById`, whose own docblock already
       * describes this fallback as the thing task surfaces depend on.
       */
      (resource === 'work_item' ? await this.lookup(tasks, id, workspaceId) : null);

    if (!projectId) {
      const [code, message] = NOT_FOUND[resource];
      throw new NotFoundException(code, message);
    }
    return projectId;
  }

  /**
   * One indexed `(id, workspace_id)` read, or null.
   *
   * Deliberately does NOT filter `deleted_at`: the guard's job is to find the owning project so a
   * permission can be checked, and a soft-deleted row still has one. The services reject the
   * deleted item themselves, with the error that actually describes the situation.
   */
  private async lookup(
    table: (typeof TABLES)[ScopedResource] | typeof tasks,
    id: string,
    workspaceId: string,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ projectId: table.projectId })
      .from(table)
      .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
}
