/**
 * Which of THREE sentences a failed `useTestResult` earns — same shape as
 * `pages/test-case/model/unavailable-reason.ts`. `GET /test-results/:id` DOES carry a
 * `@RequirePermission`, but the router does not know the project until the row loads (there is no
 * `by-key` route to resolve first), so a refusal surfaces here exactly like the Test Case case.
 *
 *   • `denied`     — 403.
 *   • `notFound`   — the query SUCCEEDED with `null` (a 404 mapped in the query fn). An answer.
 *   • `loadFailed` — a 500 or a transport fault. Not a claim about the reader or the record.
 */
export type TestResultUnavailableReason = 'denied' | 'notFound' | 'loadFailed'

export function testResultUnavailableReason(
  isError: boolean,
  error: unknown,
): TestResultUnavailableReason {
  if (!isError) return 'notFound'
  // `ApiError` carries the HTTP status precisely so this branch can exist — see
  // `testResultQueryOptions`, which throws it instead of a plain `Error`. A status we cannot read
  // is a load failure, NEVER a refusal.
  return (error as { status?: number } | undefined)?.status === 403 ? 'denied' : 'loadFailed'
}
