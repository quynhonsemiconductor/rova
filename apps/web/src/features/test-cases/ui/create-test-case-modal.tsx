/**
 * CreateTestCaseModal — Phase B (SRS §5).
 *
 * Creates a Test Case under a Work Item. Mirrors `AddTaskModal`'s shape: Project and Team are
 * inherited from the PARENT, not the app shell's selected context (P6-E2E-003's reasoning applies
 * here identically — a deep-linked Story need not match the globally selected project).
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useCreateTestCase, useTestCaseTypes } from '@/features/test-cases/api'
import { useWorkItem } from '@/features/work-items/api'
import { useTeamOwnerOptions } from '@/features/teams/api'
import { useRecordProject } from '@/shared/lib/deep-link-project'
import { useDefaultOwner } from '@/shared/lib/hooks/use-default-owner'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { FormField, ReadOnlyFieldValue } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { OwnerSelectField } from '@/shared/ui/entity-select-field'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { ProjectCell } from '@/shared/ui/project-cell'

interface Props {
  workItemId: string
  onClose: () => void
}

const METHOD_OPTIONS = ['manual', 'automated'] as const
const PRIORITY_OPTIONS = ['low', 'normal', 'high', 'urgent'] as const

export function CreateTestCaseModal({ workItemId, onClose }: Props) {
  const { t } = useTranslation('test-cases')
  const navigate = useNavigate()

  // The PARENT, not the app shell's selected project — same reasoning as AddTaskModal (P6-E2E-003):
  // a Test Case created under a known `workItemId` inherits that parent's Project and Team (BR5),
  // both properties of the parent regardless of what the shell currently has selected.
  const { data: parent } = useWorkItem(workItemId)
  const projectDisplay = useRecordProject(parent?.projectId)

  const { data: types = [] } = useTestCaseTypes(parent?.projectId)
  // Owner OPTIONS are the parent's TEAM's active members, or nothing at all (BR8, same rule Owner /
  // Assigned To / Tester all read).
  const { data: members = [] } = useTeamOwnerOptions(parent?.projectId, parent?.teamId)

  const [name, setName] = useState('')
  // Type/Method/Priority start unset here — BR2/BR3's defaults are applied by the SERVICE when the
  // field is omitted, so an untouched selector sends nothing rather than guessing the same default
  // twice. The dropdown itself still shows the resolved default via `displayType` below, since a
  // reader should see what will be chosen, not a blank field.
  const [type, setType] = useState('')
  const [method, setMethod] = useState<(typeof METHOD_OPTIONS)[number] | ''>('')
  const [priority, setPriority] = useState<(typeof PRIORITY_OPTIONS)[number] | ''>('')
  const [assigneeId, setAssigneeId] = useState('')
  // BR4: Owner defaults to the current user only when the parent Team's own feed offers them.
  const { ownerId, setOwnerId } = useDefaultOwner(members)

  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const createTestCase = useCreateTestCase(workItemId)
  const nameRef = useRef<HTMLInputElement>(null)

  const displayType = type || types[0]?.name || ''

  async function submit() {
    if (!name.trim()) {
      setError(t('create.nameRequired'))
      return
    }
    setError(null)
    setFormError(null)
    setSubmitting(true)
    try {
      const created = await createTestCase.mutateAsync({
        name: name.trim(),
        type: type || undefined,
        method: method || undefined,
        priority: priority || undefined,
        ownerId: ownerId || undefined,
        assigneeId: assigneeId || undefined,
      })
      onClose()
      // SRS §2 creation flow: on success, always navigate to the new Test Case's own detail.
      void navigate({ to: '/test-case/$testCaseKey', params: { testCaseKey: created.testCaseKey } })
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('create.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppModal
      open
      onClose={onClose}
      title={t('create.title')}
      subtitle={t('create.subtitle')}
      width={520}
    >
      <ModalBody className="space-y-4">
        {formError && (
          <p role="alert" className="text-ui-sm text-destructive">
            {formError}
          </p>
        )}

        <FormField
          label={t('create.nameLabel')}
          htmlFor="tc-name"
          required
          error={error ?? undefined}
        >
          <Input
            id="tc-name"
            ref={nameRef}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('create.namePlaceholder')}
          />
        </FormField>

        {/* Project — inherited from the parent Work Item and read-only (BR5). */}
        <FormField label={t('fields.project')}>
          <ReadOnlyFieldValue>
            <ProjectCell
              projectKey={projectDisplay?.projectKey}
              projectName={projectDisplay?.projectName}
            />
          </ReadOnlyFieldValue>
        </FormField>

        <div className="grid grid-cols-2 gap-4">
          {/* Type — defaults to the project's first selectable Type (BR2); the selector shows that
              resolved default rather than a blank field, even though an untouched selection sends
              nothing over the wire. */}
          <FormField label={t('fields.type')}>
            <SearchableSelect
              variant="field"
              value={displayType}
              ariaLabel={t('fields.type')}
              options={types.map((ty) => ({ value: ty.name, label: ty.name }))}
              onChange={(v) => setType(v ?? '')}
            />
          </FormField>

          {/* Method — defaults to Manual (BR3). */}
          <FormField label={t('fields.method')}>
            <SearchableSelect
              variant="field"
              value={method || 'manual'}
              ariaLabel={t('fields.method')}
              options={METHOD_OPTIONS.map((m) => ({ value: m, label: t(`methods.${m}`) }))}
              onChange={(v) => setMethod((v as (typeof METHOD_OPTIONS)[number]) || '')}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Priority — defaults to Normal (BR3). */}
          <FormField label={t('fields.priority')}>
            <SearchableSelect
              variant="field"
              value={priority || 'normal'}
              ariaLabel={t('fields.priority')}
              options={PRIORITY_OPTIONS.map((p) => ({ value: p, label: t(`priorities.${p}`) }))}
              onChange={(v) => setPriority((v as (typeof PRIORITY_OPTIONS)[number]) || '')}
            />
          </FormField>

          <OwnerSelectField id="tc-owner" value={ownerId} onChange={setOwnerId} members={members} />
        </div>

        {/* Assigned To — starts Unassigned (BR6), same eligibility feed as Owner (BR8). */}
        <FormField label={t('fields.assignedTo')}>
          <SearchableSelect
            variant="field"
            value={assigneeId}
            ariaLabel={t('fields.assignedTo')}
            placeholder={t('create.unassigned')}
            options={[
              { value: '', label: t('create.unassigned') },
              ...members.map((m) => ({ value: m.userId, label: m.displayName ?? m.email ?? '' })),
            ]}
            onChange={(v) => setAssigneeId(v ?? '')}
          />
        </FormField>

        <p className="text-ui-xs text-foreground-subtle">{t('create.stepsNote')}</p>
      </ModalBody>

      <ModalFooter className="justify-end">
        <div className="flex gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {t('common:cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !name.trim()}>
            {submitting && <Loader2 size={11} className="animate-spin" />}
            {submitting ? t('create.creating') : t('create.createButton')}
          </Button>
        </div>
      </ModalFooter>
    </AppModal>
  )
}
