/**
 * Target End Date on Story Detail (Phase 7 CO-03/CO-04, plan Tasks 3.5 / 4.3).
 *
 * The window comes from the SERVER (`useCarryoverOptions`); this field only disables the days that
 * payload does not enable and routes a pick:
 *   • a day inside the current Iteration → `PATCH { targetEndDate }`, no modal (CO-BR-17);
 *   • a day after it → the Carryover review modal, and nothing is saved until Accept (CO-BR-18);
 *   • Clear → `PATCH { targetEndDate: null }`, which never moves the Story (CO-BR-28).
 *
 * Disabled when the reader cannot edit, the Story is Unscheduled, or nothing is eligible (R6) — except
 * that an existing value can still be CLEARED by an editor, because clearing is always allowed.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  useCarryoverOptions,
  type CarryoverOptionIteration,
  type UpdateWorkItemInput,
  type WorkItem,
} from '@/features/work-items/api'
import { isEnabledDate, resolveSelection } from '@/features/work-items/model/target-end-date'
import { CarryoverConfirmModal } from '@/features/work-items/ui/carryover-confirm-modal'
import { DateField } from '@/shared/ui/date-field'
import { FormField } from '@/shared/ui/form-field'

const NEVER = () => true

export function TargetEndDateField({
  item,
  onUpdate,
  readOnly,
}: {
  item: Pick<WorkItem, 'id' | 'type' | 'itemKey' | 'targetEndDate'>
  onUpdate: (patch: Partial<UpdateWorkItemInput>) => void
  readOnly: boolean
}) {
  const { t } = useTranslation(['carryover', 'work-items'])
  const isStory = item.type === 'story'
  const optionsQuery = useCarryoverOptions(item.id, { enabled: isStory })
  const options = optionsQuery.data ?? null
  const [pending, setPending] = useState<{
    date: string
    targets: CarryoverOptionIteration[]
  } | null>(null)

  if (!isStory) return null

  const value = item.targetEndDate ?? null
  const pickable = !readOnly && options?.editable === true
  // Clearing an existing value stays available to an editor even when nothing is pickable.
  const editable = pickable || (!readOnly && value !== null)

  function handleChange(next: string | null) {
    if (next === null) {
      onUpdate({ targetEndDate: null })
      return
    }
    if (!options) return
    const selection = resolveSelection(next, options)
    if (selection.kind === 'inside') onUpdate({ targetEndDate: next })
    else setPending({ date: next, targets: selection.targets })
  }

  return (
    <>
      <FormField label={t('carryover:field.label')}>
        <DateField
          value={value}
          variant="field"
          readOnly={!editable}
          ariaLabel={t('carryover:field.label')}
          placeholder={t('work-items:sidebar.notSet')}
          defaultMonth={options?.minDate ?? null}
          isDateDisabled={
            pickable && options ? (iso: string) => !isEnabledDate(iso, options) : NEVER
          }
          onChange={editable ? handleChange : undefined}
        />
        {pickable && (
          <p className="mt-1 text-ui-xs text-foreground-subtle">{t('carryover:field.helper')}</p>
        )}
      </FormField>
      {pending && options?.current && (
        <CarryoverConfirmModal
          open
          onClose={() => setPending(null)}
          // The Carryover saved the date server-side; drop any staged Target End edit so the page's
          // pending patch neither overlays the new value nor re-sends a stale one on Save.
          onCarried={() => onUpdate({ targetEndDate: undefined })}
          workItemId={item.id}
          itemKey={item.itemKey}
          targetEndDate={pending.date}
          source={options.current}
          targets={pending.targets}
          taskCount={options.taskCount}
          unfinishedTaskCount={options.unfinishedTaskCount}
        />
      )}
    </>
  )
}
