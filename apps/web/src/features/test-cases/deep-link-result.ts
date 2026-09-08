/**
 * `/test-result/$testResultId` — resolve the Test Result, then adopt ITS project.
 *
 * Same shape as `deep-link.ts`'s `adoptTestCaseProject`, one field different: Test Results have
 * no `by-key` server route (plan §3 lists only `GET /test-results/:id`, UUID), so this resolves by
 * `id` directly rather than by a workspace-unique key — but the "no @RequirePermission on this
 * lookup, so the project is unknown until the row loads" shape is identical: `GET /test-results/:id`
 * IS project-scoped (`RequirePermission('test_result:view', ...)`), but the ROUTER does not know
 * the project ahead of the fetch, exactly like the Test Case case.
 */
import type { QueryClient } from '@tanstack/react-query'
import { adoptRecordProject } from '@/shared/lib/deep-link-project'
import { testResultQueryOptions } from './api'

export async function adoptTestResultProject(
  queryClient: QueryClient,
  testResultId: string,
  cause: 'preload' | 'enter' | 'stay' = 'enter',
): Promise<void> {
  const result = await queryClient
    .ensureQueryData(testResultQueryOptions(testResultId))
    // Swallowed deliberately: a 403 is already handled globally and a 404 belongs to the page's
    // own "not found" state — a loader that threw would replace both with the router's error
    // boundary.
    .catch(() => null)
  await adoptRecordProject(queryClient, result?.projectId, { commit: cause !== 'preload' })
}
