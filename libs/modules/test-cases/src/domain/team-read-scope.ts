/**
 * Re-export of the ONE team-scope decision (`AccessService.resolveTeamScope`), matching the house
 * pattern every module with team-scoped reads follows (`quality`, `work-items`).
 *
 * UNLIKE those modules, no read port here turns this into a SQL predicate: D7 (Phase 7 plan) is
 * explicit that "Test Case team scope is inherited from the parent Work Item; no second team
 * predicate on `test_cases`" — a Test Case is only reachable through its Work Item, so
 * `WorkItemsService.getWorkItemForView` (which already calls `assertTeamScope`) is the one team
 * check in this module's path (BR19).
 *
 * `scope` is still a REQUIRED parameter on every read port here, structurally, so a future call
 * site that queries `test_cases` without first authorising the parent is a compile error rather
 * than a silent widening — even though the parameter is never applied as a WHERE clause. The
 * defence is in `TestCasesService` calling `requireReadable` before any repository read, not in
 * the repository query itself.
 */
import type { TeamReadScope } from '@modules/access';

export type { TeamReadScope };
