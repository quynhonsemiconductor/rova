/**
 * The system-managed lifecycle dates on Story / Task detail (Phase 7 Carryover, CO-01 / CO-02).
 *
 * Its own file because `detail-sidebar.tsx` is already past the 500-line soft cap.
 *
 * READ-ONLY BY CONSTRUCTION, not by a disabled flag: the server stamps both dates by trigger
 * (migration 0132) and no request schema accepts them, so there is no editable state to fall back to.
 * Shown through the shared `DateField` in its read-only mode inside the same `ReadOnlyFieldValue` box
 * the Project field uses, so a fixed value looks the same wherever it appears. Blank renders `Not set`
 * (SRS §5.1) rather than `--`, matching the approved mockup.
 *
 * A Defect carries none of these dates (plan D12), so nothing renders for one.
 */
import { useTranslation } from 'react-i18next'

import type { WorkItem } from '@/features/work-items/api'
import { DateField } from '@/shared/ui/date-field'
import { FormField, ReadOnlyFieldValue } from '@/shared/ui/form-field'

function LifecycleDate({ label, value }: { label: string; value: string | null | undefined }) {
  const { t } = useTranslation('work-items')
  return (
    <FormField label={label}>
      <ReadOnlyFieldValue>
        <DateField value={value} readOnly ariaLabel={label} placeholder={t('sidebar.notSet')} />
      </ReadOnlyFieldValue>
    </FormField>
  )
}

/** Start Date — a Story's or a Task's first entry into In-Progress. */
export function StartDateField({ item }: { item: Pick<WorkItem, 'type' | 'startDate'> }) {
  const { t } = useTranslation('work-items')
  if (item.type === 'defect') return null
  return <LifecycleDate label={t('sidebar.startDate')} value={item.startDate} />
}

/** Actual End Date — a Story's first Accepted, a Task's first Completed. */
export function ActualEndDateField({ item }: { item: Pick<WorkItem, 'type' | 'actualEndDate'> }) {
  const { t } = useTranslation('work-items')
  if (item.type === 'defect') return null
  return <LifecycleDate label={t('sidebar.actualEndDate')} value={item.actualEndDate} />
}
