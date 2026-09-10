import { StatusBadge } from '@/shared/ui/status-badge'
import { TEST_VERDICT_STYLE } from '../status-colors'
import type { TestCase } from '../api'

/**
 * `verdict === null` renders `Not Run` (BR10) — never `EMPTY_VALUE` (`--`) and never `0`. This is
 * the SECOND declared exception to the app's absent-value rule, alongside Capacity's `Dependencies`
 * `0` (CLAUDE.md).
 */
export function VerdictBadge({ verdict }: { verdict: TestCase['lastVerdict'] }) {
  return <StatusBadge style={TEST_VERDICT_STYLE[verdict ?? 'not_run']} />
}
