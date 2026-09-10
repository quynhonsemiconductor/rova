/**
 * `/test-case/$testCaseKey` — resolve the Test Case, then adopt ITS project.
 *
 * Same shape as `features/work-items/deep-link.ts`'s `adoptWorkItemProject`: Test Case keys are
 * workspace-unique, and `GET /test-cases/by-key/:key` deliberately carries no `@RequirePermission`
 * — it loads the row and then authorises the parent Work Item. No project id is read from the URL.
 */
import type { QueryClient } from '@tanstack/react-query'
import { adoptRecordProject } from '@/shared/lib/deep-link-project'
import { testCaseByKeyQueryOptions } from './api'

export async function adoptTestCaseProject(
  queryClient: QueryClient,
  testCaseKey: string,
  cause: 'preload' | 'enter' | 'stay' = 'enter',
): Promise<void> {
  const testCase = await queryClient
    .ensureQueryData(testCaseByKeyQueryOptions(testCaseKey))
    // Swallowed deliberately: a 403 is already handled globally and a 404 belongs to the page's
    // own "not found" state — a loader that threw would replace both with the router's error
    // boundary.
    .catch(() => null)
  await adoptRecordProject(queryClient, testCase?.projectId, { commit: cause !== 'preload' })
}
