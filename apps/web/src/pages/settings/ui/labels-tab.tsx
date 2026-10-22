/**
 * Settings > Labels — per-project label CRUD.
 *
 * NOT WIRED INTO THE SIDEBAR, and that is the whole reason this note exists.
 * ------------------------------------------------------------------------
 * `LabelsTab` is exported and imported NOWHERE: `settings-page.tsx`'s tab registry does not list it,
 * and no other surface renders it. It lost its call site in PR 128 ("align app with BA SRS") and has
 * been unreachable since, so a reader finding this file has no way to tell whether that was a
 * decision or an accident — which is exactly the state `notifications-tab.tsx` avoids by saying so
 * in its own header.
 *
 * Recorded rather than deleted (product-owner ruling, 2026-08-23): the API it calls is live
 * (`useProjectLabels` / `useCreateLabel` / `useUpdateLabel` / `useDeleteLabel`), labels are a real
 * `project:edit` capability, and the BA has not been asked whether the surface is dropped or merely
 * unscheduled. Deleting it would throw away a working screen on a guess about the answer.
 *
 * BEFORE CHANGING THIS FILE, know that nothing renders it — a fix here reaches no user. Re-wiring it
 * is a PRODUCT decision, not a refactor: the registry mirrors the BA mockup, so adding a nav row the
 * mockup does not have needs a ruling first.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react'

import { BRAND } from '@/shared/config/brand'
import { PERMISSION } from '@/shared/config/permissions'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import {
  useProjectLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
  type ProjectLabel,
} from '@/features/projects/api'
import { notify } from '@/shared/lib/toast'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { IconButton } from '@/shared/ui/icon-button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { Spinner } from '@/shared/ui/spinner'

const DEFAULT_LABEL_COLOR = BRAND.statusDefault

export function LabelsTab() {
  const { t } = useTranslation('settings')
  const activeProject = useAppContext((s) => s.project)
  const { hasPermission } = useAuthStore()
  const canManage = hasPermission(PERMISSION.PROJECT_EDIT)
  const projectId = activeProject?.projectId

  const { data: labels = [], isLoading, isError } = useProjectLabels(projectId)
  const remove = useDeleteLabel(projectId)
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<ProjectLabel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectLabel | null>(null)

  if (!activeProject) {
    return <p className="text-ui-lg text-foreground-subtle">{t('noProjectSelected')}</p>
  }

  const ordered = [...labels].sort((a, b) => a.name.localeCompare(b.name))

  async function handleDelete(label: ProjectLabel) {
    try {
      await remove.mutateAsync(label.id)
      notify.success(t('labels.labelDeleted', { name: label.name }))
      setDeleteTarget(null)
    } catch (err) {
      notify.fromError(err, t('labels.deleteFailed'))
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-ui-lg text-muted-foreground">
          {t('labels.description')}{' '}
          <span className="font-semibold text-foreground">{activeProject.projectKey}</span>.
        </p>
        {canManage && (
          <Button variant="secondary" size="sm" type="button" onClick={() => setShowAdd(true)}>
            <Plus size={13} /> {t('labels.addLabel')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <EmptyState title={t('labels.loadError')} />
      ) : ordered.length === 0 ? (
        <EmptyState title={t('labels.empty')} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 bg-surface-hover px-3 py-2 text-ui-xs font-semibold tracking-wider text-foreground-subtle uppercase">
            <div className="flex-1">{t('labels.colLabel')}</div>
            <div className="w-28">{t('labels.colColor')}</div>
            <div className="w-20 text-right">{t('common:actions')}</div>
          </div>
          {ordered.map((label) => (
            <div
              key={label.id}
              className="flex items-center gap-2 border-t border-border-inner px-3 py-2.5"
            >
              <div className="flex flex-1 items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                <span className="text-ui-lg font-medium text-foreground">{label.name}</span>
              </div>
              <div className="w-28">
                <span className="font-mono text-ui-sm text-foreground-subtle">{label.color}</span>
              </div>
              <div className="flex w-20 items-center justify-end gap-0.5">
                {canManage && (
                  <>
                    <IconButton
                      type="button"
                      size="sm"
                      aria-label="Edit label"
                      title="Edit label"
                      onClick={() => setEditTarget(label)}
                    >
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label="Delete label"
                      title="Delete label"
                      onClick={() => setDeleteTarget(label)}
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
        <LabelModal projectId={projectId} onClose={() => setShowAdd(false)} />
      )}
      {editTarget && projectId && (
        <LabelModal projectId={projectId} label={editTarget} onClose={() => setEditTarget(null)} />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={t('labels.deleteTitle')}
        confirmText={deleteTarget?.name ?? ''}
        message={t('labels.deleteMessage')}
        confirmLabel={t('labels.deleteConfirm')}
        pending={remove.isPending}
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

function LabelModal({
  projectId,
  label,
  onClose,
}: {
  projectId: string
  label?: ProjectLabel
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const isEdit = !!label
  const [name, setName] = useState(label?.name ?? '')
  const [color, setColor] = useState(label?.color ?? DEFAULT_LABEL_COLOR)
  const create = useCreateLabel(projectId)
  const update = useUpdateLabel(projectId)
  const pending = create.isPending || update.isPending

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      if (isEdit) {
        await update.mutateAsync({ labelId: label.id, input: { name: name.trim(), color } })
        notify.success(t('labels.labelUpdated', { name: name.trim() }))
      } else {
        await create.mutateAsync({ name: name.trim(), color })
        notify.success(t('labels.labelAdded', { name: name.trim() }))
      }
      onClose()
    } catch (err) {
      notify.fromError(err, t('labels.saveFailed'))
    }
  }

  return (
    <AppModal
      open
      onClose={onClose}
      title={isEdit ? t('labels.editTitle') : t('labels.addLabel')}
      width={420}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <ModalBody className="space-y-4">
          <FormField label={t('labels.labelNameLabel')} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bug"
              autoFocus
            />
          </FormField>
          <FormField label={t('labels.colorLabel')}>
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
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending && <Loader2 size={12} className="animate-spin" />}
            {isEdit ? t('labels.saveLabel') : t('labels.addLabel')}
          </Button>
        </ModalFooter>
      </form>
    </AppModal>
  )
}
