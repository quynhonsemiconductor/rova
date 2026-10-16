/**
 * Milestones — P3.3
 *
 * Lists milestones for the active project. Milestones live under
 * Plan > Timeboxes alongside Iterations and Releases.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { AlertTriangle, Plus, Trash2, PackageOpen, Loader2 } from 'lucide-react'
import { TimeboxTypeSwitcher } from '@/pages/timeboxes/timebox-type-switcher'
import { MILESTONE_STATUS_STYLE } from '@/features/milestones/status-colors'
import { ColumnFieldsMenu } from '@/shared/ui/column-fields-menu'
import { useDataTable, type ColumnSpec } from '@/shared/ui/table'
import { ListPageScaffold } from '@/shared/ui/list-page/list-page-scaffold'
import { ListPageHeader } from '@/shared/ui/list-page/list-page-header'
import { MetricStrip } from '@/shared/ui/metric-strip'
import { MetricCard } from '@/shared/ui/metric-card'
import { type RowSelection } from '@/shared/lib/hooks/use-row-selection'
import { useTableSort } from '@/shared/lib/hooks/use-table-sort'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { InlineSelect } from '@/shared/ui/native-select'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { ownerSelectOptions } from '@/shared/ui/owner-cell'
import { Textarea } from '@/shared/ui/textarea'
import { DateField } from '@/shared/ui/date-field'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useProjectPermissions } from '@/features/access/api'
import {
  useMilestones,
  useCreateMilestone,
  useUpdateMilestone,
  useDeleteMilestone,
  type Milestone,
  type MilestoneStatus,
} from '@/features/milestones/api'
import { InlineEditableCell } from '@/shared/ui/inline-editable-cell'
import { useReleases } from '@/features/releases/api'
import { useProjectMembers } from '@/features/teams/api'
import { entityDetailPath } from '@/shared/lib/entity-link'

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE = MILESTONE_STATUS_STYLE

const MILESTONE_STATUSES: MilestoneStatus[] = [
  'planned',
  'at_risk',
  'met',
  'missed',
  'cancelled',
  'completed',
]

// ── Shared modal body ────────────────────────────────────────────────────────

function MilestoneFormFields({
  name,
  setName,
  description,
  setDescription,
  notes,
  setNotes,
  status,
  setStatus,
  ownerId,
  setOwnerId,
  targetStartDate,
  setTargetStartDate,
  targetEndDate,
  setTargetEndDate,
  selectedReleases,
  toggleRelease,
  releases,
  members,
}: {
  name: string
  setName: (v: string) => void
  description: string
  setDescription: (v: string) => void
  notes: string
  setNotes: (v: string) => void
  status: MilestoneStatus
  setStatus: (v: MilestoneStatus) => void
  ownerId: string
  setOwnerId: (v: string) => void
  targetStartDate: string
  setTargetStartDate: (v: string) => void
  targetEndDate: string
  setTargetEndDate: (v: string) => void
  selectedReleases: string[]
  toggleRelease: (rid: string) => void
  releases: { id: string; name: string }[] | undefined
  members: { userId: string; displayName?: string; email?: string }[] | undefined
}) {
  const { t } = useTranslation(['milestones', 'iterations'])
  return (
    <>
      <FormField label={t('form.nameLabel')} required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Q4 Release Candidate"
          autoFocus
        />
      </FormField>
      <FormField label={t('common:status')}>
        <SearchableSelect
          variant="field"
          value={status}
          ariaLabel={t('common:status')}
          options={MILESTONE_STATUSES.map((s) => ({
            value: s,
            label: STATUS_STYLE[s].label,
          }))}
          onChange={(v) => setStatus(v as MilestoneStatus)}
        />
      </FormField>
      <FormField label={t('common:description')}>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Milestone description..."
          rows={2}
        />
      </FormField>
      <FormField label={t('form.notesLabel')}>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Internal notes..."
          rows={2}
        />
      </FormField>
      <FormField label={t('common:owner')}>
        <SearchableSelect
          variant="field"
          value={ownerId}
          ariaLabel={t('common:owner')}
          placeholder={t('form.unassigned')}
          options={ownerSelectOptions(members ?? [], ownerId)}
          onChange={setOwnerId}
        />
      </FormField>
      {/* Target dates: manual/editable while NO Release is linked; once a Release
          is associated they become derived (read-only) — reconciled SRS §2 /
          P3-MS-019. The derived values are computed server-side after save. */}
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('form.targetStart')}>
          {selectedReleases.length > 0 ? (
            <>
              <div className="w-full rounded-md border border-border-strong bg-surface-subtle px-3 py-1.5 text-ui-xl text-foreground-subtle">
                {t('form.notSet')}
              </div>
              <p className="mt-0.5 text-ui-xs text-foreground-subtle">
                {t('form.derivedFromReleases')}
              </p>
            </>
          ) : (
            <DateField
              variant="field"
              value={targetStartDate || null}
              ariaLabel={t('form.targetStart')}
              onChange={(v) => setTargetStartDate(v ?? '')}
            />
          )}
        </FormField>
        <FormField label={t('form.targetEnd')}>
          {selectedReleases.length > 0 ? (
            <>
              <div className="w-full rounded-md border border-border-strong bg-surface-subtle px-3 py-1.5 text-ui-xl text-foreground-subtle">
                {t('form.notSet')}
              </div>
              <p className="mt-0.5 text-ui-xs text-foreground-subtle">
                {t('form.derivedFromReleases')}
              </p>
            </>
          ) : (
            <DateField
              variant="field"
              value={targetEndDate || null}
              ariaLabel={t('form.targetEnd')}
              onChange={(v) => setTargetEndDate(v ?? '')}
            />
          )}
        </FormField>
      </div>
      <FormField label={t('form.associatedReleases')}>
        <div className="flex max-h-32 flex-col gap-1.5 overflow-y-auto rounded-md border border-border-strong p-2">
          {releases && releases.length > 0 ? (
            releases.map((r) => (
              <label
                key={r.id}
                className="flex cursor-pointer items-center gap-2 text-ui-md select-none"
              >
                <input
                  type="checkbox"
                  checked={selectedReleases.includes(r.id)}
                  onChange={() => toggleRelease(r.id)}
                />
                <span>{r.name}</span>
              </label>
            ))
          ) : (
            <span className="text-ui-md text-foreground-subtle">{t('form.noReleases')}</span>
          )}
        </div>
      </FormField>
    </>
  )
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateMilestoneModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation('milestones')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<MilestoneStatus>('planned')
  const [targetStartDate, setTargetStartDate] = useState('')
  const [targetEndDate, setTargetEndDate] = useState('')
  const [selectedReleases, setSelectedReleases] = useState<string[]>([])
  const [ownerId, setOwnerId] = useState('')
  const { data: releases } = useReleases(projectId)
  const { data: members } = useProjectMembers(projectId)
  const create = useCreateMilestone()

  function toggleRelease(rid: string) {
    setSelectedReleases((prev) =>
      prev.includes(rid) ? prev.filter((id) => id !== rid) : [...prev, rid],
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await create.mutateAsync({
        projectId,
        name: name.trim(),
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
        status,
        ownerId: ownerId || undefined,
        releaseIds: selectedReleases,
        // Manual dates only apply when no Release is linked; when releases are
        // selected the server derives + overrides them, so don't send stale input.
        targetStartDate: selectedReleases.length === 0 ? targetStartDate || undefined : undefined,
        targetEndDate: selectedReleases.length === 0 ? targetEndDate || undefined : undefined,
      })
      toast.success(t('create.created', { name }))
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('create.createFailed'))
    }
  }

  return (
    <AppModal open onClose={onClose} title={t('create.title')} width={480}>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
      >
        <ModalBody className="space-y-4">
          <MilestoneFormFields
            name={name}
            setName={setName}
            description={description}
            setDescription={setDescription}
            notes={notes}
            setNotes={setNotes}
            status={status}
            setStatus={setStatus}
            ownerId={ownerId}
            setOwnerId={setOwnerId}
            targetStartDate={targetStartDate}
            setTargetStartDate={setTargetStartDate}
            targetEndDate={targetEndDate}
            setTargetEndDate={setTargetEndDate}
            selectedReleases={selectedReleases}
            toggleRelease={toggleRelease}
            releases={releases}
            members={members}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending && <Loader2 size={12} className="animate-spin" />}
            {create.isPending ? t('create.creating') : t('create.createButton')}
          </Button>
        </ModalFooter>
      </form>
    </AppModal>
  )
}

// ── Table columns (shared useDataTable engine) ───────────────────────────────

type MilestoneColKey = 'id' | 'name' | 'targetStartDate' | 'targetEndDate' | 'status'

/** Per-render context handed to each cell (permissions + row callbacks). */
interface MilestoneCtx {
  canManage: boolean
  onOpen: (id: string) => void
}

/** Name inline-edit cell — matches the Releases / Iteration-Status Name column
 *  (the ID cell is the click-to-open link; Name edits in place). */
function MilestoneNameCell({ milestone, canEdit }: { milestone: Milestone; canEdit: boolean }) {
  const { t } = useTranslation('milestones')
  const update = useUpdateMilestone()
  function commit(raw: string) {
    const next = raw.trim()
    if (!next || next === milestone.name) return
    update.mutate(
      { id: milestone.id, name: next },
      {
        onSuccess: () => toast.success(t('row.nameUpdated')),
        onError: (err) => toast.error(err instanceof Error ? err.message : t('row.updateFailed')),
      },
    )
  }
  return (
    <InlineEditableCell
      value={milestone.name}
      canEdit={canEdit}
      onCommit={commit}
      fullCell
      ariaLabel="Name"
      title={milestone.name}
      className="block w-full break-words whitespace-normal text-foreground"
      style={{ fontSize: 12 }}
      inputClassName="w-full rounded bg-transparent text-ui-sm text-foreground focus:outline-none"
    />
  )
}

/** Status editable dropdown — shared SearchableSelect, like the Releases State
 *  column. Milestone status is freely editable (no gated lifecycle). */
function MilestoneStatusCell({ milestone, canEdit }: { milestone: Milestone; canEdit: boolean }) {
  const { t } = useTranslation('milestones')
  const update = useUpdateMilestone()
  function change(v: string) {
    if (v === milestone.status) return
    update.mutate(
      { id: milestone.id, status: v as MilestoneStatus },
      {
        onSuccess: () => toast.success(t('row.statusUpdated')),
        onError: (err) => toast.error(err instanceof Error ? err.message : t('row.updateFailed')),
      },
    )
  }
  return (
    <SearchableSelect
      value={milestone.status}
      readOnly={!canEdit}
      ariaLabel="Status"
      options={MILESTONE_STATUSES.map((s) => ({ value: s, label: STATUS_STYLE[s].label }))}
      onChange={change}
    />
  )
}

/**
 * Single per-column source of truth. The shared {@link useDataTable} engine
 * derives the header, resize / reorder / show-hide behaviour and body cells
 * from this array — identical to the Projects / Quality grids.
 */
const MILESTONES_COLUMNS: ColumnSpec<Milestone, MilestoneCtx, MilestoneColKey>[] = [
  {
    key: 'id',
    label: 'ID',
    defaultWidth: 84,
    minWidth: 60,
    locked: true,
    sortCol: 'milestoneKey',
    cellClassName: 'flex items-center px-2',
    cell: (m, ctx) => (
      <IdCell
        type="milestone"
        itemKey={m.milestoneKey ?? '--'}
        onOpen={() => ctx.onOpen(m.id)}
        href={entityDetailPath.milestone(m.id)}
      />
    ),
  },
  {
    key: 'name',
    label: 'Name',
    defaultWidth: 260,
    minWidth: 120,
    locked: true,
    grow: true,
    sortCol: 'name',
    cellClassName: 'flex min-w-0 items-center px-0',
    cell: (m, ctx) => <MilestoneNameCell milestone={m} canEdit={ctx.canManage} />,
  },
  {
    key: 'targetStartDate',
    label: 'Target Start Date',
    defaultWidth: 152,
    minWidth: 90,
    sortCol: 'targetStartDate',
    cellClassName: 'flex items-center px-2',
    type: 'date',
  },
  {
    key: 'targetEndDate',
    label: 'Target End Date',
    defaultWidth: 138,
    minWidth: 90,
    sortCol: 'targetEndDate',
    cellClassName: 'flex items-center px-2',
    type: 'date',
  },
  {
    key: 'status',
    label: 'Status',
    defaultWidth: 120,
    minWidth: 90,
    sortCol: 'status',
    cellClassName: 'flex items-center px-0',
    // Editable inline via the shared SearchableSelect (matches Releases State).
    cell: (m, ctx) => <MilestoneStatusCell milestone={m} canEdit={ctx.canManage} />,
  },
]

// ── Milestones page ───────────────────────────────────────────────────────────

export function MilestonesPage() {
  const { t } = useTranslation('milestones')
  const { project } = useAppContext()
  const table = useDataTable<Milestone, MilestoneCtx, MilestoneColKey>(MILESTONES_COLUMNS, {
    storageKey: STORAGE_KEYS.MILESTONES_COLUMNS,
    // Leading gutter = RowGutter (inert grip + selection checkbox), matching the
    // Iteration Status grid so header/rows/totals stay column-aligned.
    leadingWidth: 36,
  })
  const { can } = useProjectPermissions(project?.projectId)
  const canManage = can('milestone:create') || can('milestone:edit') || can('milestone:delete')
  const { data: milestones, isLoading, error } = useMilestones(project?.projectId)
  const deleteMilestone = useDeleteMilestone()
  const navigate = useNavigate()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<MilestoneStatus | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)

  const searched = useMemo(() => {
    if (!milestones) return []
    const q = search.toLowerCase()
    return milestones.filter(
      (m) =>
        (statusFilter === 'all' || m.status === statusFilter) &&
        (m.name.toLowerCase().includes(q) || m.description?.toLowerCase().includes(q)),
    )
  }, [milestones, search, statusFilter])

  const activeFilterCount = statusFilter !== 'all' ? 1 : 0

  const { sortField, sortDir, toggle } = useTableSort<MilestoneColKey>()
  const filtered = useMemo(() => {
    if (!sortField) return searched
    const dir = sortDir === 'desc' ? -1 : 1
    return [...searched].sort((a, b) => {
      const av = (a as unknown as Record<string, string | number | null>)[sortField] ?? ''
      const bv = (b as unknown as Record<string, string | number | null>)[sortField] ?? ''
      if (av < bv) return -dir
      if (av > bv) return dir
      return 0
    })
  }, [searched, sortField, sortDir])

  // ── KPI metrics (parity with Iteration Status / Releases metric strip) ──────
  const metrics = useMemo(() => {
    const all = milestones ?? []
    const by = (s: MilestoneStatus) => all.filter((m) => m.status === s).length
    return {
      total: all.length,
      planned: by('planned'),
      atRisk: by('at_risk'),
      completed: by('met') + by('completed'),
    }
  }, [milestones])

  // Bulk delete — the scaffold owns selection; the confirm dialog is rendered
  // inside `bulkActions` so it has the live `RowSelection` in scope.
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  async function handleBulkDelete(selection: RowSelection) {
    try {
      await Promise.all([...selection.selectedIds].map((id) => deleteMilestone.mutateAsync(id)))
      toast.success(t('delete.deleted'))
      selection.clear()
      setConfirmBulkDelete(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('delete.deleteFailed'))
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
        <AlertTriangle size={32} className="text-destructive" />
        <p className="text-ui-xl text-muted-foreground">
          {error instanceof Error ? error.message : t('loadError')}
        </p>
      </div>
    )
  }

  const cellCtx: MilestoneCtx = {
    canManage,
    onOpen: (id) => navigate({ to: '/milestones/$milestoneId', params: { milestoneId: id } }),
  }

  return (
    <>
      <ListPageScaffold<Milestone, MilestoneColKey>
        header={
          <ListPageHeader
            title={t('iterations:title')}
            accessory={<TimeboxTypeSwitcher current="milestones" />}
          />
        }
        metrics={
          <MetricStrip>
            <MetricCard label={t('metrics.total')} value={metrics.total} minWidth={90} />
            <MetricCard label={t('metrics.planned')} value={metrics.planned} minWidth={90} />
            <MetricCard label={t('metrics.atRisk')} value={metrics.atRisk} minWidth={90} />
            <MetricCard label={t('metrics.completed')} value={metrics.completed} minWidth={90} />
          </MetricStrip>
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search milestones…',
          ariaLabel: 'Search milestones',
          width: 200,
        }}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              {t('common:addNew')}
            </Button>
          ) : undefined
        }
        activeFilterCount={activeFilterCount}
        filters={
          <label className="flex items-center gap-1.5 text-ui-sm font-semibold text-muted-foreground">
            {t('common:status')}
            <InlineSelect
              value={statusFilter}
              aria-label="Filter by status"
              onChange={(e) => setStatusFilter(e.target.value as MilestoneStatus | 'all')}
              className="w-auto"
            >
              <option value="all">{t('filters.allStatuses')}</option>
              {MILESTONE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_STYLE[s].label}
                </option>
              ))}
            </InlineSelect>
          </label>
        }
        fields={<ColumnFieldsMenu {...table.fieldsMenuProps} />}
        bulkActions={
          canManage
            ? (selection) => (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(true)}
                    disabled={deleteMilestone.isPending}
                    className="flex items-center gap-1 rounded px-2 py-1 text-ui-sm font-medium text-destructive transition-colors hover:bg-card disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                    {t('common:delete')}
                  </button>
                  <ConfirmDialog
                    open={confirmBulkDelete}
                    title={t('delete.title')}
                    message={t('delete.bulkMessage', { count: selection.count })}
                    confirmLabel={t('common:delete')}
                    destructive
                    pending={deleteMilestone.isPending}
                    onConfirm={() => void handleBulkDelete(selection)}
                    onCancel={() => setConfirmBulkDelete(false)}
                  />
                </>
              )
            : undefined
        }
        headerProps={table.headerProps}
        headerColumns={table.headerColumns}
        colStyles={table.colStyles}
        sort={{
          col: sortField ?? '',
          dir: sortDir ?? 'asc',
          onSort: (c) => toggle(c as MilestoneColKey),
        }}
        padClassName="gap-2 px-3"
        items={filtered}
        loading={isLoading}
        skeleton={{ rows: 6 }}
        empty={
          filtered.length === 0 ? (
            <EmptyState
              className="flex-1"
              icon={<PackageOpen size={40} className="text-foreground-faint" />}
              title={search ? t('emptySearch') : t('empty')}
              action={
                canManage && !search ? (
                  <Button size="sm" onClick={() => setShowCreate(true)}>
                    <Plus size={14} />
                    {t('createMilestone')}
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
        renderRow={(ms, { gutter }) => (
          <div
            key={ms.id}
            className="flex min-h-[35px] items-center gap-2 border-b border-border-inner px-3 text-ui-md transition-colors hover:bg-primary-lighter"
            style={{ minWidth: 'max-content' }}
          >
            {gutter}
            {table.renderCells(ms, cellCtx)}
          </div>
        )}
      />

      {showCreate && (
        <CreateMilestoneModal
          projectId={project?.projectId ?? ''}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  )
}
