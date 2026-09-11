/**
 * Test Case Results tab (Phase D — SRS §7, §8). The list, latest-first by default (server-ordered,
 * BR14), `Add Result` opens the create modal (`test_result:create`-gated), and Verdict/Duration/
 * Tester are inline-editable with `test_result:edit` — the columns the Test Result Detail page
 * itself lets you edit and that have a natural cell-scale equivalent.
 *
 * Sort and filter are CLIENT-side, matching Tasks tab / the Test Cases tab exactly — the list
 * route (`GET :id/test-results`) takes no query params at all, on purpose: one Test Case's whole
 * Result history loads at once.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical } from 'lucide-react'
import { useTestResults } from '@/features/test-cases/api'
import {
  testResultColumns,
  VERDICT_LABEL,
  type TestResultColKey,
} from '@/features/test-cases/model/test-result-columns'
import { AddTestResultModal } from '@/features/test-cases/ui/add-test-result-modal'
import { useProjectMemberOptions } from '@/features/teams/api'
import { listResource } from '@/shared/lib/query/resource'
import { DataTableFrame, useDataTable } from '@/shared/ui/table'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { useProjectPermissions } from '@/features/access/api'
import { TestResultRow } from './test-result-row'
import type { TestResult } from '@/features/test-cases/api'

export function ResultsTab({
  testCaseId,
  projectId,
  teamId,
  workItemKey,
}: {
  testCaseId: string
  projectId: string
  /** The owning Test Case's own team (BR5) — Tester's per-row offer feed is scoped to it. */
  teamId: string | null
  /** The Test Case's own Work Product item key — ONE value for the whole tab (BR13). */
  workItemKey: string | null
}) {
  const { t } = useTranslation('test-cases')
  const { can } = useProjectPermissions(projectId)
  const canCreate = can('test_result:create')
  const canEdit = can('test_result:edit')
  const [creating, setCreating] = useState(false)

  const query = useTestResults(testCaseId)
  const results = listResource(query)

  // Project-wide member feed — reused for the Tester filter's options/names. `TestResultRow`
  // already loads a TEAM-scoped tester feed per row for the inline-edit picker, but that is
  // fragmented per row's team; the tab-level filter needs one list, so it reads the same
  // project-wide feed the Test Cases tab's own Owner filter uses (React Query dedupes the
  // identical key, so this is not a second live request when both tabs are mounted).
  const memberFeed = listResource(useProjectMemberOptions(projectId))

  const columns = testResultColumns()
  const table = useDataTable(columns, { storageKey: 'test-results:columns' })

  // Search — matches Build and Tester name, the two free-text-ish fields a reader scans this
  // grid by (mirrors Tasks tab's own search-by-title-and-key shape).
  const [search, setSearch] = useState('')

  // Client-side column sort — `null` keeps the server's own latest-first order (BR14).
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleSort(col: string) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  // Client-side Verdict + Tester filters — same shape as Tasks tab's State filter and the Test
  // Cases tab's own filters.
  const [verdictFilter, setVerdictFilter] = useState('all')
  const [testerFilter, setTesterFilter] = useState('all')
  const usedVerdicts = useMemo(
    () => [...new Set(results.rows.map((r) => r.verdict))].sort(),
    [results.rows],
  )
  /** The Testers actually recorded on this Test Case's Results, named from the project member
   *  feed (a tester who has since left the project is still named via the row's own
   *  `testerName`). */
  const usedTesters = useMemo(() => {
    const ids = [...new Set(results.rows.map((r) => r.testerId).filter((id): id is string => !!id))]
    return ids
      .map((id) => {
        const member = memberFeed.rows.find((m) => m.userId === id)
        const name =
          member?.displayName ??
          member?.email ??
          results.rows.find((r) => r.testerId === id)?.testerName ??
          id
        return { id, name }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [results.rows, memberFeed.rows])

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return results.rows.filter(
      (r) =>
        (needle === '' ||
          r.build.toLowerCase().includes(needle) ||
          (r.testerName ?? '').toLowerCase().includes(needle)) &&
        (verdictFilter === 'all' || r.verdict === verdictFilter) &&
        (testerFilter === 'all' || r.testerId === testerFilter),
    )
  }, [results.rows, search, verdictFilter, testerFilter])

  const sortedRows = useMemo(() => {
    if (!sortCol) return visibleRows
    const factor = sortDir === 'asc' ? 1 : -1
    const numeric = sortCol === 'durationMinutes'
    const value = (r: TestResult): string | number => {
      switch (sortCol) {
        case 'build':
          return r.build.toLowerCase()
        case 'runDate':
          return r.runDate
        case 'verdict':
          return VERDICT_LABEL[r.verdict]
        case 'durationMinutes':
          return r.durationMinutes
        case 'testerName':
          return (r.testerName ?? '').toLowerCase()
        default:
          return ''
      }
    }
    return [...visibleRows].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (numeric) return ((av as number) - (bv as number)) * factor
      return String(av).localeCompare(String(bv)) * factor
    })
  }, [visibleRows, sortCol, sortDir])

  const colStyles = table.colStyles as Record<TestResultColKey, React.CSSProperties>

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {creating && (
        <AddTestResultModal
          testCaseId={testCaseId}
          projectId={projectId}
          onClose={() => setCreating(false)}
        />
      )}
      <PageToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('results.search'),
          ariaLabel: t('results.search'),
          width: 220,
        }}
        actions={
          <Button
            size="sm"
            disabled={!canCreate}
            title={canCreate ? undefined : t('results.addNew.noPermission')}
            onClick={() => setCreating(true)}
          >
            {t('results.addNew.label')}
          </Button>
        }
        activeFilterCount={(verdictFilter !== 'all' ? 1 : 0) + (testerFilter !== 'all' ? 1 : 0)}
        defaultFiltersOpen={verdictFilter !== 'all' || testerFilter !== 'all'}
        filters={
          <>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('results.columns.verdict')}
              <InlineSelect
                value={verdictFilter}
                aria-label={t('results.filters.verdict')}
                onChange={(e) => setVerdictFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {usedVerdicts.map((v) => (
                  <option key={v} value={v}>
                    {VERDICT_LABEL[v]}
                  </option>
                ))}
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('results.columns.tester')}
              <InlineSelect
                value={testerFilter}
                aria-label={t('results.filters.tester')}
                onChange={(e) => setTesterFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {usedTesters.map((tester) => (
                  <option key={tester.id} value={tester.id}>
                    {tester.name}
                  </option>
                ))}
              </InlineSelect>
            </label>
          </>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />
      <DataTableFrame
        header={{ ...table.headerProps, sort: { col: sortCol, dir: sortDir, onSort: toggleSort } }}
        loading={results.isLoading}
        error={
          results.isError ? (
            <EmptyState
              title={t('results.error.title')}
              description={t('results.error.description')}
              size="sm"
            />
          ) : undefined
        }
        empty={
          results.phase === 'empty' ? (
            <EmptyState
              icon={<FlaskConical size={32} className="text-border-strong" />}
              title={t('results.empty.title')}
              description={t('results.empty.description')}
              size="sm"
            />
          ) : undefined
        }
      >
        {sortedRows.map((row) => (
          <TestResultRow
            key={`${row.id}:${row.updatedAt}`}
            result={row}
            canEdit={canEdit}
            colStyles={colStyles}
            workItemKey={workItemKey}
            projectId={projectId}
            teamId={teamId}
          />
        ))}
      </DataTableFrame>
    </div>
  )
}
