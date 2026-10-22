import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderKanban, Plus, Archive, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { BRAND } from '@/shared/config/brand'
import { BulkBarButton } from '@/shared/ui/bulk-action-bar'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { MetricCard } from '@/shared/ui/metric-card'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { Button } from '@/shared/ui/button'
import { InlineSelect } from '@/shared/ui/native-select'
import { RowGutter } from '@/shared/ui/row-gutter'
import { PageToolbar } from '@/shared/ui/page-toolbar'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { PaginationFooter } from '@/shared/ui/pagination-footer'
import { useDataTable, SelectableTable } from '@/shared/ui/table'
import { useRowSelection, type RowSelection } from '@/shared/lib/hooks/use-row-selection'
import { listResource } from '@/shared/lib/query/resource'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { PERMISSION } from '@/shared/config/permissions'
import { useProjects, useUpdateProject, useDeleteProject } from '@/features/projects/api'
import type { Project } from '@/features/projects/api'
import { useWorkspaceMemberOptions } from '@/features/workspaces/api'
import { type ProjectColKey, type ProjectCtx } from './model/columns'
import { PROJECT_COLUMNS, NewProjectModal } from './ui/project-parts'
import { entityDetailPath } from '@/shared/lib/entity-link'

export function ProjectsPage() {
  const { t } = useTranslation('projects')
  const navigate = useNavigate()
  const { workspace } = useAppContext()
  const workspaceId = workspace?.workspaceId
  const { user: currentUser, hasPermission } = useAuthStore()
  const isWorkspaceAdmin = hasPermission(PERMISSION.WORKSPACE_ALL)

  // Bound to its own const before `listResource` — the React Compiler stops trusting a component
  // whose hook result is a plain function's argument (see `resource.ts`), and `pnpm lint` fails on it.
  const projectsQuery = useProjects(workspaceId)
  const projectsRes = listResource(projectsQuery)
  const projects = projectsRes.rows
  const { data: wsMembers = [] } = useWorkspaceMemberOptions(workspaceId)
  const update = useUpdateProject()

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'All' | 'active' | 'archived'>('active')
  const [pageSize, setPageSize] = useState(25)
  const [currentPage, setCurrentPage] = useState(1)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [showNewModal, setShowNewModal] = useState(false)

  const handleSort = useCallback(
    (col: string) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else {
        setSortCol(col)
        setSortDir('asc')
      }
    },
    [sortCol],
  )

  const table = useDataTable<Project, ProjectCtx, ProjectColKey>(PROJECT_COLUMNS, {
    storageKey: STORAGE_KEYS.PROJECTS_COLUMNS,
    sort: { col: sortCol, dir: sortDir, onSort: handleSort },
  })

  const filtered = useMemo(
    () =>
      projects.filter(
        (p) =>
          (filter === 'All' || p.status === filter) &&
          (p.name.toLowerCase().includes(search.toLowerCase()) ||
            p.key.toLowerCase().includes(search.toLowerCase())),
      ),
    [projects, filter, search],
  )

  const sorted = useMemo(() => {
    if (!sortCol) return filtered
    const dir = sortDir === 'asc' ? 1 : -1
    const keyOf = (p: Project): string | number => {
      switch (sortCol) {
        case 'key':
          return p.key.toLowerCase()
        case 'name':
          return p.name.toLowerCase()
        case 'status':
          return p.status
        case 'members':
          return p.memberCount
        case 'startDate':
          return p.startDate ?? ''
        case 'endDate':
          return p.endDate ?? ''
        case 'updated':
          return p.updatedAt
        default:
          return ''
      }
    }
    return [...filtered].sort((a, b) => {
      const av = keyOf(a)
      const bv = keyOf(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [filtered, sortCol, sortDir])

  const resetKey = `${search}|${filter}|${pageSize}`
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setCurrentPage(1)
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(currentPage, pageCount)
  const paged = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)

  const selection = useRowSelection(paged)

  const activeCount = projects.filter((p) => p.status === 'active').length
  const stats = {
    total: projects.length,
    active: activeCount,
    archived: projects.filter((p) => p.status === 'archived').length,
    linkedTeams: projects.reduce((sum, p) => sum + (p.teamCount ?? 0), 0),
  }

  /**
   * A tile is a MEASUREMENT over the whole set, so it may only print while the whole set is here.
   *
   * Two ways it would otherwise lie, and neither looks broken: a failed load leaves `rows` empty and
   * every tile reads `0` ("this workspace has no projects"), and the drain lands page by page, so a
   * count taken mid-drain is the first N rows presented as the total — the same silent truncation
   * `limit: 100` used to ship, now transient instead of permanent. `EMPTY_VALUE` ('--') is this app's
   * answer for a number it does not have.
   */
  const counted = !projectsRes.isError && !projectsRes.isLoading && !projectsQuery.isLoadingMore
  const metric = (n: number) => (counted ? n : EMPTY_VALUE)

  /**
   * `canEdit` and `onPatch` are set from ONE condition, deliberately: every mutating cell on this
   * grid needs `workspace:edit` and nothing else (`projects.controller.ts:276,505,520`), and the two
   * defects being fixed here were exactly a control whose gate and whose write had come apart —
   * five editors that opened with `onPatch` undefined, and a Teams picker with no gate at all.
   *
   * `hasPermission(WORKSPACE_ALL)` is the check the rest of this page already uses for "is this a
   * Workspace Admin" (New Project, the bulk bar), and it answers the `workspace:edit` question
   * exactly: `workspace_admin` is the only role holding either code (`db/permissions.catalog.ts`
   * :379-384 — `workspace:*` is admin-reserved and no `ACCESS_LEVEL_PERMISSIONS` entry carries a
   * `workspace:` code), and `grants()` treats `workspace:*` as granting everything. Not
   * `useProjectPermissions`: a project-tier lookup cannot add a workspace-tier code, and this is
   * one row per project rather than one project.
   */
  const cellCtx: ProjectCtx = {
    currentUserId: currentUser?.id,
    currentUserName: currentUser?.displayName,
    members: wsMembers,
    canEdit: isWorkspaceAdmin,
    onPatch: isWorkspaceAdmin ? (id, input) => update.mutate({ id, input }) : undefined,
    onOpen: (key) => void navigate({ href: entityDetailPath.project(key) }),
  }

  const statusFilter = (
    <InlineSelect
      value={filter}
      onChange={(e) => setFilter(e.target.value as 'All' | 'active' | 'archived')}
      aria-label={t('common:status')}
      className="w-auto"
    >
      <option value="All">{t('status.all')}</option>
      <option value="active">{t('status.active')}</option>
      <option value="archived">{t('status.archived')}</option>
    </InlineSelect>
  )

  return (
    <div className="flex flex-1 flex-col bg-background">
      {showNewModal && workspaceId && (
        <NewProjectModal workspaceId={workspaceId} onClose={() => setShowNewModal(false)} />
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card px-6 py-3">
        <div>
          <h1 className="text-ui-xl font-semibold text-foreground">{t('title')}</h1>
          <p className="text-ui-sm text-foreground-subtle">
            {workspace?.workspaceName ?? t('subtitle.workspace')} · {metric(activeCount)}{' '}
            {activeCount === 1 ? t('subtitle.oneActive') : t('subtitle.manyActive')}
          </p>
        </div>
      </div>

      {/* Summary metric strip (KPI) */}
      <MetricStrip>
        <MetricCard label={t('metrics.total')} value={metric(stats.total)} minWidth={80} />
        <MetricCard
          label={t('metrics.active')}
          value={metric(stats.active)}
          valueColor={BRAND.primaryLight}
          minWidth={80}
        />
        <MetricCard label={t('metrics.archived')} value={metric(stats.archived)} minWidth={90} />
        <MetricCard
          label={t('metrics.linkedTeams')}
          value={metric(stats.linkedTeams)}
          minWidth={110}
        />
      </MetricStrip>

      {/* Shared toolbar — search / New Project / Filters / Show Fields (same as
          iteration-status et al). */}
      <PageToolbar
        search={{ value: search, onChange: setSearch, placeholder: t('search') }}
        actions={
          isWorkspaceAdmin ? (
            <Button size="sm" onClick={() => setShowNewModal(true)}>
              <Plus size={13} />
              {t('create.title')}
            </Button>
          ) : undefined
        }
        filters={statusFilter}
        activeFilterCount={filter === 'active' ? 0 : 1}
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
      />

      <SelectableTable
        rows={paged}
        selection={selection}
        headerProps={table.headerProps}
        padClassName="gap-2 px-3"
        loading={projectsRes.isLoading}
        skeleton={{ rows: 8, cols: PROJECT_COLUMNS.length }}
        empty={
          // `error` before `empty`: an unfiltered grid whose request failed used to render
          // "No projects match these filters", a fact about the FILTER for a fact about the network.
          projectsRes.isError ? (
            <LoadErrorState error={projectsRes.error} title={t('detail.loadError')} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={
                <FolderKanban
                  size={32}
                  strokeWidth={1.25}
                  className="text-foreground-subtle opacity-40"
                />
              }
              title={t('emptyFiltered')}
              description={t('emptyFilteredDesc')}
            />
          ) : undefined
        }
        bulkActions={
          isWorkspaceAdmin
            ? (sel) => <ProjectsBulkBar selection={sel} projects={paged} />
            : undefined
        }
        footer={
          filtered.length > 0 ? (
            <PaginationFooter
              pageSize={pageSize}
              setPageSize={setPageSize}
              currentPage={safePage}
              rangeStart={(safePage - 1) * pageSize + 1}
              rangeEnd={(safePage - 1) * pageSize + paged.length}
              total={filtered.length}
              pageCount={pageCount}
              hasPrevPage={safePage > 1}
              hasNextPage={safePage < pageCount}
              onPrevPage={() => setCurrentPage((p) => Math.max(1, p - 1))}
              onNextPage={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
            />
          ) : undefined
        }
        renderRow={(project, { selected, onToggleSelect }) => (
          <div
            key={project.id}
            className="flex min-h-12 items-center gap-2 border-b border-border-inner px-3 transition-colors hover:bg-surface-hover"
            style={{
              opacity: project.status === 'archived' ? 0.7 : 1,
              minWidth: 'max-content',
              backgroundColor: selected ? BRAND.surfaceSubtle : undefined,
            }}
          >
            <RowGutter
              stopPropagation
              checkbox={{
                checked: selected,
                onChange: onToggleSelect,
                ariaLabel: t('detail.tabs.details'),
              }}
            />
            {table.renderCells(project, cellCtx)}
          </div>
        )}
      />
    </div>
  )
}

// ── Bulk action bar (Archive / Restore / Delete over the selection) ──────────

function ProjectsBulkBar({
  selection,
  projects,
}: {
  selection: RowSelection
  projects: readonly Project[]
}) {
  const { t } = useTranslation('projects')
  const update = useUpdateProject()
  const del = useDeleteProject()
  const [confirm, setConfirm] = useState<'archive' | 'restore' | 'delete' | null>(null)
  const ids = [...selection.selectedIds]
  const selected = projects.filter((p) => selection.selectedIds.has(p.id))
  const anyActive = selected.some((p) => p.status === 'active')
  const anyArchived = selected.some((p) => p.status === 'archived')

  /**
   * What the operator must type to delete. `ConfirmDialog` switches to typed mode on this prop.
   *
   * `Phase 4/03_Settings_Audit` P4-SET-07 §9 (P4-SET-008, P4-SET-013, tracker `GAP-P4-SET-004`)
   * requires a typed confirmation on the IRREVERSIBLE actions. Delete had a plain confirm, so the
   * whole gate was one misplaced click — `del.mutateAsync` runs over every selected id at once.
   *
   * One project: its KEY, which is the shortest unambiguous handle and what the (never-wired)
   * `ArchiveConfirmModal` in `ui/project-parts.tsx` also asks for. Several: a fixed word, because
   * there is no single name to quote and listing N of them turns the gate into a transcription
   * exercise the operator will paste around.
   *
   * ARCHIVE deliberately keeps its plain confirm: its own message says "You can restore them
   * later", and a gate on a reversible action trains people to type through gates.
   */
  const deleteConfirmText =
    selected.length === 1 ? (selected[0]?.key ?? t('bulk.confirmWord')) : t('bulk.confirmWord')

  async function run(fn: (id: string) => Promise<unknown>, okKey: string) {
    try {
      await Promise.all(ids.map(fn))
      toast.success(t(okKey, { count: ids.length }))
      selection.clear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.unexpected'))
    }
  }

  return (
    <div className="flex items-center gap-1">
      {anyActive && (
        <BulkBarButton
          icon={<Archive size={13} />}
          label={t('actions.archive')}
          onClick={() => setConfirm('archive')}
        />
      )}
      {anyArchived && (
        <BulkBarButton
          icon={<RotateCcw size={13} />}
          label={t('actions.restore')}
          onClick={() => setConfirm('restore')}
        />
      )}
      <BulkBarButton
        danger
        icon={<Trash2 size={13} />}
        label={t('bulk.delete')}
        onClick={() => setConfirm('delete')}
      />

      <ConfirmDialog
        open={confirm === 'archive'}
        title={t('actions.archive')}
        message={t('bulk.confirmArchive', {
          defaultValue: 'Archive {{count}} project(s)? You can restore them later.',
          count: ids.length,
        })}
        confirmLabel={t('actions.archive')}
        pending={update.isPending}
        onConfirm={() => {
          setConfirm(null)
          void run(
            (id) => update.mutateAsync({ id, input: { status: 'archived' } }),
            'toast.archivedN',
          )
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'restore'}
        title={t('actions.restore')}
        message={t('bulk.confirmRestore', {
          defaultValue: 'Restore {{count}} project(s) to active?',
          count: ids.length,
        })}
        confirmLabel={t('actions.restore')}
        pending={update.isPending}
        onConfirm={() => {
          setConfirm(null)
          void run(
            (id) => update.mutateAsync({ id, input: { status: 'active' } }),
            'toast.restoredN',
          )
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={t('bulk.delete')}
        message={t('bulk.confirmDelete', { count: ids.length })}
        confirmLabel={t('bulk.delete')}
        confirmText={deleteConfirmText}
        destructive
        pending={del.isPending}
        onConfirm={() => {
          setConfirm(null)
          void run((id) => del.mutateAsync(id), 'toast.deletedN')
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
