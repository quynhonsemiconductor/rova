/**
 * Settings > Workflow — per-project schedule-state / flow-state configuration.
 *
 * NOT WIRED INTO THE SIDEBAR — see the identical note on `labels-tab.tsx`, which is unreachable for
 * the same reason and since the same change (PR 128). `WorkflowTab` is exported and imported nowhere;
 * `settings-page.tsx`'s registry does not list it.
 *
 * Recorded rather than deleted (product-owner ruling, 2026-08-23). Its hooks are live
 * (`useProjectStatuses` / `useCreateStatus` / `useDeleteStatus` / `useReorderStatuses`) and workflow
 * status configuration is one of the two things `project:edit` is deliberately kept in the Admin set
 * FOR (CLAUDE.md, "A per-Project `Admin` has NO structural authority"), so the capability is real
 * even while this screen is not reachable.
 *
 * A fix here reaches no user until something renders it, and re-wiring it is a product decision
 * rather than a refactor.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ChevronUp, ChevronDown, Trash2, Loader2 } from 'lucide-react'

import { BRAND } from '@/shared/config/brand'
import { cn } from '@/shared/lib/utils'
import { PERMISSION } from '@/shared/config/permissions'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import {
  useProjectStatuses,
  useCreateStatus,
  useDeleteStatus,
  useReorderStatuses,
  type ProjectStatus,
} from '@/features/projects/api'
import { notify } from '@/shared/lib/toast'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { IconButton } from '@/shared/ui/icon-button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { Spinner } from '@/shared/ui/spinner'

const STATUS_CATEGORIES = [
  { value: 'to_do', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
] as const

type StatusCategory = (typeof STATUS_CATEGORIES)[number]['value']

/** Token classes for a workflow-status category badge. */
function statusCategoryClass(category: StatusCategory): string {
  switch (category) {
    case 'in_progress':
      return 'bg-warning-bg text-warning'
    case 'done':
      return 'bg-success-bg text-success'
    case 'to_do':
    default:
      return 'bg-surface-subtle text-muted-foreground'
  }
}

function categoryLabel(category: string): string {
  return STATUS_CATEGORIES.find((c) => c.value === category)?.label ?? category
}

function AddStatusModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState('')
  const [category, setCategory] = useState<StatusCategory>('to_do')
  const [color, setColor] = useState<string>(BRAND.statusDefault)
  const create = useCreateStatus(projectId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await create.mutateAsync({ name: name.trim(), category, color })
      notify.success(t('workflow.statusAdded', { name: name.trim() }))
      onClose()
    } catch (err) {
      notify.fromError(err, t('workflow.addFailed'))
    }
  }

  return (
    <AppModal open onClose={onClose} title={t('workflow.addStatus')} width={420}>
      {/* The flex column lives on the FORM — see the note in `projects/ui/project-parts.tsx`: a
          plain form between AppModal and ModalBody stops the body scrolling, because the body is
          then a flex child of the form rather than of the height-capped card. */}
      <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <FormField label={t('workflow.statusNameLabel')} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="In Review"
              autoFocus
            />
          </FormField>
          <FormField label={t('workflow.categoryLabel')} required>
            <SearchableSelect
              variant="field"
              value={category}
              ariaLabel={t('workflow.categoryLabel')}
              options={STATUS_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
              onChange={(v) => setCategory(v as StatusCategory)}
            />
          </FormField>
          <FormField label={t('workflow.colorLabel')}>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-16 cursor-pointer rounded-md border bg-card p-1"
            />
          </FormField>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending && <Loader2 size={12} className="animate-spin" />}
            {t('workflow.addStatus')}
          </Button>
        </ModalFooter>
      </form>
    </AppModal>
  )
}

export function WorkflowTab() {
  const { t } = useTranslation('settings')
  const activeProject = useAppContext((s) => s.project)
  const { hasPermission } = useAuthStore()
  const canManage = hasPermission(PERMISSION.PROJECT_EDIT)
  const projectId = activeProject?.projectId

  const { data: statuses = [], isLoading, isError } = useProjectStatuses(projectId)
  const reorder = useReorderStatuses(projectId)
  const remove = useDeleteStatus(projectId)
  const [showAdd, setShowAdd] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectStatus | null>(null)

  if (!activeProject) {
    return <p className="text-ui-lg text-foreground-subtle">{t('noProjectSelected')}</p>
  }

  const ordered = [...statuses].sort((a, b) => a.position - b.position)

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= ordered.length) return
    const ids = ordered.map((s) => s.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    try {
      await reorder.mutateAsync(ids)
    } catch (err) {
      notify.fromError(err, t('workflow.reorderFailed'))
    }
  }

  async function handleDelete(status: ProjectStatus) {
    try {
      await remove.mutateAsync(status.id)
      notify.success(t('workflow.statusDeleted', { name: status.name }))
      setDeleteTarget(null)
    } catch (err) {
      notify.fromError(err, t('workflow.deleteFailed'))
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-ui-lg text-muted-foreground">
          {t('workflow.description')}{' '}
          <span className="font-semibold text-foreground">{activeProject.projectKey}</span>.
        </p>
        {canManage && (
          <Button variant="secondary" size="sm" type="button" onClick={() => setShowAdd(true)}>
            <Plus size={13} /> {t('workflow.addStatus')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <EmptyState title={t('workflow.loadError')} />
      ) : ordered.length === 0 ? (
        <EmptyState title={t('workflow.empty')} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 bg-surface-hover px-3 py-2 text-ui-xs font-semibold tracking-wider text-foreground-subtle uppercase">
            <div className="flex-1">{t('workflow.colName')}</div>
            <div className="w-28">{t('workflow.colCategory')}</div>
            <div className="w-16 text-center">{t('workflow.colDefault')}</div>
            <div className="w-24 text-right">{t('common:actions')}</div>
          </div>
          {ordered.map((status, index) => (
            <div
              key={status.id}
              className="flex items-center gap-2 border-t border-border-inner px-3 py-2.5"
            >
              <div className="flex flex-1 items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: status.color ?? BRAND.textMuted }}
                />
                <span className="text-ui-lg font-medium text-foreground">{status.name}</span>
              </div>
              <div className="w-28">
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-ui-xs font-semibold',
                    statusCategoryClass(status.category as StatusCategory),
                  )}
                >
                  {categoryLabel(status.category)}
                </span>
              </div>
              <div className="w-16 text-center">
                {status.isDefault && (
                  <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {t('workflow.defaultBadge')}
                  </span>
                )}
              </div>
              <div className="flex w-24 items-center justify-end gap-0.5">
                {canManage && (
                  <>
                    <IconButton
                      type="button"
                      size="sm"
                      aria-label="Move up"
                      title="Move up"
                      onClick={() => void move(index, -1)}
                      disabled={index === 0 || reorder.isPending}
                    >
                      <ChevronUp size={14} />
                    </IconButton>
                    <IconButton
                      type="button"
                      size="sm"
                      aria-label="Move down"
                      title="Move down"
                      onClick={() => void move(index, 1)}
                      disabled={index === ordered.length - 1 || reorder.isPending}
                    >
                      <ChevronDown size={14} />
                    </IconButton>
                    <IconButton
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label="Delete status"
                      title="Delete status"
                      onClick={() => setDeleteTarget(status)}
                      disabled={remove.isPending}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && projectId && (
        <AddStatusModal projectId={projectId} onClose={() => setShowAdd(false)} />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={t('workflow.deleteTitle')}
        confirmText={deleteTarget?.name ?? ''}
        message={t('workflow.deleteMessage')}
        confirmLabel={t('workflow.deleteConfirm')}
        pending={remove.isPending}
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
