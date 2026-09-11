/**
 * The per-project Test Case Type catalog (SRS §3, Phase G). Modelled on `EstimationSettingsBlock`
 * in `workspace-projects-panel.tsx` — a self-contained block rendered on the Details tab, gated on
 * `isWA` the same way. `Add New`/`×` (archive) render only for a Workspace Admin (SRS §3.3); other
 * readers see the chip list read-only, since they hold `test_case:view` (the GET route's gate).
 *
 * English-first, no `t()` — matches this file's own surface: `fe-consistency.ratchet.test.ts`
 * names "Workspaces & Projects tree/detail/teams/overview/edit" as deferred-i18n.
 */
import { useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import {
  useTestCaseTypes,
  useCreateTestCaseType,
  useArchiveTestCaseType,
  type TestCaseType,
} from '@/features/test-cases/api'
import { notify } from '@/shared/lib/toast'
import { Button } from '@/shared/ui/button'
import { IconButton } from '@/shared/ui/icon-button'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'

const MAX_NAME_LENGTH = 60

export function TestCaseTypesSection({ projectId, isWA }: { projectId: string; isWA: boolean }) {
  const { data: types = [], isLoading } = useTestCaseTypes(projectId)
  const archiveType = useArchiveTestCaseType(projectId)
  const [adding, setAdding] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<TestCaseType | null>(null)

  function confirmArchive() {
    if (!archiveTarget) return
    const target = archiveTarget
    archiveType.mutate(target.id, {
      onSuccess: () => {
        notify.success(`"${target.name}" removed`)
        setArchiveTarget(null)
      },
      onError: (e) => notify.fromError(e, 'Failed to remove Test Case Type'),
    })
  }

  return (
    <div className="rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-ui-sm font-semibold text-foreground">Test Case Types</h3>
          <p className="mt-0.5 text-ui-xs text-foreground-subtle">
            The Type options offered when creating or editing a Test Case in this project.
          </p>
        </div>
        {isWA && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add New
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <Loader2 size={13} className="animate-spin" /> Loading Test Case Types…
        </div>
      ) : types.length === 0 ? (
        <p className="mt-3 text-ui-sm text-foreground-subtle">No Test Case Types yet.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {types.map((ty) => (
            <span
              key={ty.id}
              className="flex items-center gap-1.5 rounded-full bg-surface-hover px-3 py-1 text-ui-sm text-foreground"
            >
              {ty.name}
              {isWA && (
                <IconButton
                  aria-label={`Remove ${ty.name}`}
                  size="sm"
                  onClick={() => setArchiveTarget(ty)}
                >
                  <X size={12} />
                </IconButton>
              )}
            </span>
          ))}
        </div>
      )}

      {adding && <AddTestCaseTypeModal projectId={projectId} onClose={() => setAdding(false)} />}

      <ConfirmDialog
        open={!!archiveTarget}
        title="Remove Test Case Type"
        message="Existing Test Cases keep their historical Type value. This Type will no longer be offered for new or edited Test Cases."
        confirmLabel="Remove"
        destructive
        pending={archiveType.isPending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  )
}

function AddTestCaseTypeModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateTestCaseType(projectId)

  const trimmed = name.trim()
  const lengthError =
    trimmed.length > MAX_NAME_LENGTH ? `Must be ${MAX_NAME_LENGTH} characters or fewer` : null
  const canSave = trimmed.length > 0 && !lengthError

  async function submit() {
    if (!canSave) return
    setError(null)
    try {
      await create.mutateAsync(trimmed)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add Test Case Type')
    }
  }

  return (
    <AppModal open onClose={onClose} title="Add Test Case Type" width={420}>
      <ModalBody className="space-y-4">
        <FormField
          label="Name"
          htmlFor="test-case-type-name"
          required
          error={lengthError ?? error ?? undefined}
        >
          <Input
            id="test-case-type-name"
            autoFocus
            value={name}
            maxLength={MAX_NAME_LENGTH + 1}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </FormField>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={!canSave || create.isPending}>
          {create.isPending && <Loader2 size={12} className="animate-spin" />}
          Save
        </Button>
      </ModalFooter>
    </AppModal>
  )
}
