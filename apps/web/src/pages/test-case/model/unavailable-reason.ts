/**
 * Which of THREE sentences a failed `useTestCaseByKey` earns — the same shape
 * `pages/work-item/model/unavailable-reason.ts` uses, for the same reason: `by-key` carries no
 * `@RequirePermission` (Test Case keys are workspace-unique, so the owning project is unknown
 * until the row loads), so a refusal on the parent Work Item surfaces here as a 403.
 *
 *   • `denied`     — 403. `getByKey` throws when `getWorkItemForView` refuses the parent.
 *   • `notFound`   — the query SUCCEEDED with `null` (a 404 mapped in the query fn). An answer.
 *   • `loadFailed` — a 500 or a transport fault. Not a claim about the reader or the record.
 */
export type TestCaseUnavailableReason = 'denied' | 'notFound' | 'loadFailed'

export function testCaseUnavailableReason(
  isError: boolean,
  error: unknown,
): TestCaseUnavailableReason {
  if (!isError) return 'notFound'
  // `ApiError` carries the HTTP status precisely so this branch can exist — see
  // `testCaseByKeyQueryOptions`, which throws it instead of a plain `Error`. A status we cannot
  // read is a load failure, NEVER a refusal.
  return (error as { status?: number } | undefined)?.status === 403 ? 'denied' : 'loadFailed'
}
