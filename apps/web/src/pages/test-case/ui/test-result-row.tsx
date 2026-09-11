/**
 * One inline-editable row on the Results tab (Verdict/Duration/Tester/Date — the columns the Test
 * Result Detail page itself lets you edit and that have a natural cell-scale equivalent; Build
 * links to that detail page rather than editing in place, and Work Product stays read-only here,
 * BR13). BR13 covers only Test Case/Work Product — it says nothing about Date, so Date is
 * editable here too, the same grid-cell `DateField` pattern Projects' Start/End Date columns use.
 *
 * Verdict shows the styled `VerdictBadge` as its AT-REST display via `SearchableSelect`'s
 * `triggerContent`, not a bare label — `canEdit` gates whether the cell CAN be edited, not
 * whether it is currently mid-edit, so the trigger must carry the same styling the read-only
 * branch renders or every editable row silently loses its colored pill.
 *
 * Hand-rendered rather than going through `useDataTable().renderCells`, because Tester's picker
 * needs a per-row `useTeamOwnerOptions` call (a `ColumnSpec.cell` is a plain function and cannot
 * call hooks) — the same shape `TestCaseRow` / Tasks tab's `TaskRow` use.
 */
import type { CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'

import {
  VERDICT_LABEL,
  type TestResultColKey,
} from '@/features/test-cases/model/test-result-columns'
import { useUpdateTestResult, type TestResult } from '@/features/test-cases/api'
import { useTeamOwnerOptions } from '@/features/teams/api'
import { listResource } from '@/shared/lib/query/resource'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { OwnerSelectCell } from '@/shared/ui/owner-cell'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { DateField } from '@/shared/ui/date-field'
import { VerdictBadge } from '@/features/test-cases/ui/verdict-badge'

const VERDICT_OPTIONS = Object.entries(VERDICT_LABEL).map(([value, label]) => ({ value, label }))

export function TestResultRow({
  result,
  canEdit,
  colStyles,
  workItemKey,
  projectId,
  teamId,
}: {
  result: TestResult
  canEdit: boolean
  colStyles: Record<TestResultColKey, CSSProperties>
  workItemKey: string | null
  projectId: string
  /** The owning Test Case's own team (BR5, read-only) — Tester's offer feed is scoped to it,
   *  same rule Owner/Assigned To follow on the Test Case Detail page. */
  teamId: string | null
}) {
  const update = useUpdateTestResult(result.id)

  const testerOptionsQuery = useTeamOwnerOptions(projectId, teamId)
  const testerOptions = listResource(testerOptionsQuery).rows

  const commitDuration = (raw: string) => {
    const next = Math.max(0, Number(raw) || 0)
    if (next !== result.durationMinutes) update.mutate({ durationMinutes: next })
  }

  return (
    <div className="group flex min-h-[35px] items-center border-b border-border-inner px-3 text-ui-md transition-colors hover:bg-primary-lighter">
      <div style={colStyles.build} className="min-w-0 px-2">
        <Link
          to="/test-result/$testResultId"
          params={{ testResultId: result.id }}
          className="block min-w-0 truncate font-mono text-ui-md text-primary-light underline-offset-2 hover:underline"
        >
          {result.build}
        </Link>
      </div>
      <div style={colStyles.runDate} className="px-2">
        {/* Same grid-cell date pattern Projects' Start/End Date columns already use
            (`project-parts.tsx`) — BR13 only makes Test Case/Work Product read-only; it says
            nothing about Date, and the Detail page's own sidebar already lets you edit it. */}
        <DateField
          value={result.runDate}
          readOnly={!canEdit || update.isPending}
          ariaLabel={`Test result ${result.testResultKey} date`}
          onChange={(v) => v && v !== result.runDate && update.mutate({ runDate: v })}
        />
      </div>
      <div style={colStyles.workProduct} className="px-2">
        <span className="font-mono text-ui-sm text-foreground">{workItemKey ?? EMPTY_VALUE}</span>
      </div>
      <div style={colStyles.verdict} className="px-2">
        {canEdit ? (
          <div onClick={(e) => e.stopPropagation()} className="w-full">
            {/*
             * `canEdit` gates whether the cell CAN be edited, not whether it currently IS being
             * edited — `SearchableSelect`'s own `cell` variant already shows plain text at rest and
             * only reveals its border/chevron on hover, so the popover-trigger shape itself is
             * right. The bug was styling: with no `triggerContent`, the trigger fell back to a
             * bare label ("Pass"/"Fail" as plain text), permanently dropping the colored
             * `VerdictBadge` pill every OTHER Verdict display (the Test Case Detail sidebar's own
             * Last Verdict, this same cell read-only) renders. `triggerContent` renders the styled
             * badge as the AT-REST display while keeping the click-to-open picker and its chevron.
             */}
            <SearchableSelect
              value={result.verdict}
              readOnly={update.isPending}
              ariaLabel={`Test result ${result.testResultKey} verdict`}
              options={VERDICT_OPTIONS}
              triggerContent={<VerdictBadge verdict={result.verdict} />}
              onChange={(v) =>
                v !== result.verdict && update.mutate({ verdict: v as TestResult['verdict'] })
              }
            />
          </div>
        ) : (
          <VerdictBadge verdict={result.verdict} />
        )}
      </div>
      <div style={colStyles.duration} className="px-2">
        <InlineEditableCell
          value={String(result.durationMinutes)}
          canEdit={canEdit && !update.isPending}
          onCommit={commitDuration}
          displayValue={`${result.durationMinutes}m`}
          className="font-mono text-ui-sm text-foreground hover:underline"
          inputClassName="w-16 rounded border border-input bg-card px-1 py-0.5 text-ui-sm focus:outline-none"
          ariaLabel={`Test result ${result.testResultKey} duration`}
        />
      </div>
      <div style={colStyles.tester} className="overflow-hidden px-2">
        <OwnerSelectCell
          ownerName={result.testerName}
          assigneeId={result.testerId}
          members={testerOptions}
          canEdit={canEdit && !update.isPending}
          onChange={(userId) => userId && update.mutate({ testerId: userId })}
          ariaLabel={`Test result ${result.testResultKey} tester`}
        />
      </div>
    </div>
  )
}
