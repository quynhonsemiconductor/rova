/**
 * Test Cases tab on Story/Defect detail (Phase 7, Phase A read path + Phase B create + Phase F
 * delete/reorder).
 *
 * The list, in rank order by default, the ID cell opens the Test Case's own detail route,
 * `Add New` opens the create modal (`test_case:create`-gated — AC3/B4), each row carries a drag
 * grip + a selection checkbox in the shared `<RowGutter>` leading gutter (F3, and Select All
 * parity with Tasks tab), and selecting ≥1 row reveals Delete + Copy in the shared bulk bar
 * (`test_case:delete`-gated for Delete).
 *
 * Sort and filter are CLIENT-side, matching Tasks tab exactly (`tasks-tab.tsx`) — the backend list
 * route takes no query params for either (`TestCaseListQuerySchema = PageQuerySchema`), on purpose:
 * one Work Item's whole Test Case set loads at once (bounded, rank-ordered, drag-reorder needs the
 * full set in memory anyway), so a server sort/filter would be a second, redundant definition of an
 * ordering the client already owns.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { FlaskConical, Plus } from 'lucide-react'
import {
  useReorderTestCase,
  useTestCases,
  useTestCaseTypes,
  type TestCase,
} from '@/features/test-cases/api'
import {
  testCaseColumns,
  METHOD_LABEL,
  PRIORITY_LABEL,
} from '@/features/test-cases/model/test-case-columns'
import { CreateTestCaseModal } from '@/features/test-cases/ui/create-test-case-modal'
import { TestCaseBulkDeleteCopy } from '@/features/test-cases/ui/test-case-bulk-delete-copy'
import { useProjectMemberOptions } from '@/features/teams/api'
import { listResource } from '@/shared/lib/query/resource'
import { useDataTable, useRowRerank, SelectableTable } from '@/shared/ui/table'
import { useRowSelection } from '@/shared/lib/hooks/use-row-selection'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { InlineSelect } from '@/shared/ui/native-select'
import { useProjectPermissions } from '@/features/access/api'
import { TestCaseRow } from './test-case-row'

const VERDICT_LABEL: Record<string, string> = {
  pass: 'Pass',
  fail: 'Fail',
  blocked: 'Blocked',
  error: 'Error',
  inconclusive: 'Inconclusive',
  not_run: 'Not Run',
}

export function TestCasesTab({ workItemId, projectId }: { workItemId: string; projectId: string }) {
  const { t } = useTranslation('test-cases')
  const navigate = useNavigate()
  const { can } = useProjectPermissions(projectId)
  const canCreate = can('test_case:create')
  const canEdit = can('test_case:edit')
  const canDelete = can('test_case:delete')
  const [creating, setCreating] = useState(false)

  const query = useTestCases(workItemId)
  const testCases = listResource(query)

  const typeFeed = listResource(useTestCaseTypes(projectId))
  const typeOptions = typeFeed.rows.map((ty) => ({ value: ty.name, label: ty.name }))

  // Project-wide member feed — the same one Tasks tab uses to name AND filter by Owner
  // (`tasks-tab.tsx`'s own `membersQuery`). Cheap and already fetched: it is also the id→name
  // source `ownerOptionsFor`-style lookups need, so an Owner filter costs nothing extra here.
  const memberFeed = listResource(useProjectMemberOptions(projectId))

  const columns = testCaseColumns()
  const table = useDataTable(columns, { storageKey: 'test-cases:columns', leadingWidth: 48 })

  // Search — same shape as Tasks tab's own `search` state, matched against Name (the field a
  // reader actually scans this grid by) and the item key.
  const [search, setSearch] = useState('')

  // Client-side column sort — mirrors Tasks tab's own `sortCol`/`sortDir` state. `null` = the
  // default rank order.
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const toggleSort = useCallback(
    (col: string) => {
      if (sortCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )

  // Client-side filters — same toolbar shape as Tasks tab's State filter, one dropdown per field
  // that has a small, closed set of values (Type/Method/Priority/Last Verdict/Owner). Owner reads
  // `memberFeed` above, the same project-wide feed Tasks tab already uses for its own Owner
  // column — no second fetch.
  const [typeFilter, setTypeFilter] = useState('all')
  const [methodFilter, setMethodFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [verdictFilter, setVerdictFilter] = useState('all')
  const [ownerFilter, setOwnerFilter] = useState('all')

  const activeFilterCount =
    (typeFilter !== 'all' ? 1 : 0) +
    (methodFilter !== 'all' ? 1 : 0) +
    (priorityFilter !== 'all' ? 1 : 0) +
    (verdictFilter !== 'all' ? 1 : 0) +
    (ownerFilter !== 'all' ? 1 : 0)

  /** The Types actually in use on this Work Item's Test Cases, so the filter never offers an
   *  empty result — same reasoning as Tasks tab's own `taskStates`. */
  const usedTypes = useMemo(
    () => [...new Set(testCases.rows.map((tc) => tc.type))].sort(),
    [testCases.rows],
  )

  /** The Owners actually assigned on this Work Item's Test Cases, named from the project member
   *  feed (an owner who has since left the project is still named via the row's own `ownerName`,
   *  same fallback `ownerOptionsFor` uses elsewhere). */
  const usedOwners = useMemo(() => {
    const ids = [
      ...new Set(testCases.rows.map((tc) => tc.ownerId).filter((id): id is string => !!id)),
    ]
    return ids
      .map((id) => {
        const member = memberFeed.rows.find((m) => m.userId === id)
        const name =
          member?.displayName ??
          member?.email ??
          testCases.rows.find((tc) => tc.ownerId === id)?.ownerName ??
          id
        return { id, name }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [testCases.rows, memberFeed.rows])

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return testCases.rows.filter(
      (tc) =>
        (needle === '' ||
          tc.testCaseKey.toLowerCase().includes(needle) ||
          tc.name.toLowerCase().includes(needle)) &&
        (typeFilter === 'all' || tc.type === typeFilter) &&
        (methodFilter === 'all' || tc.method === methodFilter) &&
        (priorityFilter === 'all' || tc.priority === priorityFilter) &&
        (verdictFilter === 'all' || (tc.lastVerdict ?? 'not_run') === verdictFilter) &&
        (ownerFilter === 'all' || tc.ownerId === ownerFilter),
    )
  }, [testCases.rows, search, typeFilter, methodFilter, priorityFilter, verdictFilter, ownerFilter])

  const sortedRows = useMemo(() => {
    if (!sortCol) return visibleRows
    const factor = sortDir === 'asc' ? 1 : -1
    const value = (tc: TestCase): string => {
      switch (sortCol) {
        case 'id':
          return tc.testCaseKey
        case 'name':
          return tc.name.toLowerCase()
        case 'type':
          return tc.type.toLowerCase()
        case 'method':
          return METHOD_LABEL[tc.method]
        case 'priority':
          return PRIORITY_LABEL[tc.priority]
        case 'owner':
          return (tc.ownerName ?? '').toLowerCase()
        case 'lastVerdict':
          return VERDICT_LABEL[tc.lastVerdict ?? 'not_run']
        case 'lastRun':
          return tc.lastRun ?? ''
        default:
          return ''
      }
    }
    return [...visibleRows].sort((a, b) => value(a).localeCompare(value(b)) * factor)
  }, [visibleRows, sortCol, sortDir])

  // Row selection (shared pattern with Backlog / Iteration Status / Tasks tab): the header
  // checkbox selects every visible row, each row toggles itself.
  const selection = useRowSelection(sortedRows)

  // Rank drag-reorder (F3). Disabled while a non-rank sort is active (order detaches from rank,
  // same rule Tasks tab applies) or the caller lacks edit.
  const reorderMutation = useReorderTestCase(workItemId)
  const rerank = useRowRerank({
    items: sortedRows,
    disabled: sortCol !== null || !canEdit,
    onReorder: ({ id, beforeId, afterId }) =>
      reorderMutation.mutate(
        { id, beforeId, afterId },
        { onError: (err) => toast.error(err instanceof Error ? err.message : t('reorder.failed')) },
      ),
  })

  function openTestCase(testCase: TestCase) {
    void navigate({ to: '/test-case/$testCaseKey', params: { testCaseKey: testCase.testCaseKey } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {creating && (
        <CreateTestCaseModal workItemId={workItemId} onClose={() => setCreating(false)} />
      )}

      <PageToolbar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('search'),
          ariaLabel: t('search'),
          width: 220,
        }}
        actions={
          <Button
            size="sm"
            disabled={!canCreate}
            title={canCreate ? undefined : t('addNew.noPermission')}
            onClick={() => setCreating(true)}
          >
            <Plus size={14} /> {t('addNew.label')}
          </Button>
        }
        activeFilterCount={activeFilterCount}
        defaultFiltersOpen={activeFilterCount > 0}
        filters={
          <>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('columns.type')}
              <InlineSelect
                value={typeFilter}
                aria-label={t('filters.type')}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {usedTypes.map((ty) => (
                  <option key={ty} value={ty}>
                    {ty}
                  </option>
                ))}
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('columns.method')}
              <InlineSelect
                value={methodFilter}
                aria-label={t('filters.method')}
                onChange={(e) => setMethodFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {Object.entries(METHOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('columns.priority')}
              <InlineSelect
                value={priorityFilter}
                aria-label={t('filters.priority')}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('columns.lastVerdict')}
              <InlineSelect
                value={verdictFilter}
                aria-label={t('filters.verdict')}
                onChange={(e) => setVerdictFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {Object.entries(VERDICT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </InlineSelect>
            </label>
            <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
              {t('columns.owner')}
              <InlineSelect
                value={ownerFilter}
                aria-label={t('filters.owner')}
                onChange={(e) => setOwnerFilter(e.target.value)}
                className="w-auto"
              >
                <option value="all">{t('filters.all')}</option>
                {usedOwners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </InlineSelect>
            </label>
          </>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      <SelectableTable
        rows={rerank.items}
        selection={selection}
        selectAllAriaLabel="Select all test cases"
        headerProps={table.headerProps}
        sort={{ col: sortCol, dir: sortDir, onSort: toggleSort }}
        padClassName="px-3"
        dnd={{
          dndContextProps: rerank.dndContextProps,
          sortableContextProps: rerank.sortableContextProps,
        }}
        bulkActions={(sel) => (
          <TestCaseBulkDeleteCopy
            workItemId={workItemId}
            testCases={rerank.items}
            selection={sel}
            canDelete={canDelete}
          />
        )}
        loading={testCases.isLoading}
        skeleton={{ rows: 5 }}
        error={
          testCases.isError ? (
            <EmptyState title={t('error.title')} description={t('error.description')} size="sm" />
          ) : undefined
        }
        empty={
          testCases.phase === 'empty' ? (
            <EmptyState
              icon={<FlaskConical size={32} className="text-border-strong" />}
              title={t('empty.title')}
              description={t('empty.description')}
              size="sm"
            />
          ) : undefined
        }
        renderRow={(row, { selected, onToggleSelect }) => (
          <TestCaseRow
            key={`${row.id}:${row.updatedAt}`}
            testCase={row}
            rowNum={rerank.items.indexOf(row) + 1}
            canEdit={canEdit}
            dragDisabled={sortCol !== null || !canEdit}
            colStyles={table.colStyles}
            typeOptions={typeOptions}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onOpen={openTestCase}
          />
        )}
      />
    </div>
  )
}
