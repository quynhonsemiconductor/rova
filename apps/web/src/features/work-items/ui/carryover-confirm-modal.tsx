/**
 * The Carryover review modal (Phase 7 CO-04/CO-05, plan Task 4.2).
 *
 * Opened when the reader picks a Target End Date AFTER the current Iteration. Nothing is persisted
 * until Accept: Cancel, ✕ and Escape all close through `onClose` with no API call (CO-BR-25), and the
 * PATCH path is never taken for such a date (the server refuses it anyway,
 * `TARGET_END_REQUIRES_CARRYOVER`).
 *
 * Targets come from `resolveSelection` over the SERVER's eligible list: one is proposed, several make
 * the reader choose (Accept disabled until they do), none shows the no-destination state with Accept
 * disabled (CO-BR-19/20). The POST re-validates everything, echoing the source Iteration it rendered.
 */
import { useState } from 'react'
import { ArrowRight, CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { formatDateIso } from '@/shared/lib/utils'

import { useCarryOverWorkItem, type CarryoverOptionIteration } from '../carryover-api'

export interface CarryoverSource {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
}

export interface CarryoverConfirmModalProps {
  open: boolean
  onClose: () => void
  /** Called after a successful Carryover, once the modal has closed. */
  onCarried?: () => void
  workItemId: string
  itemKey: string
  targetEndDate: string
  source: CarryoverSource
  targets: CarryoverOptionIteration[]
  taskCount: number
  unfinishedTaskCount: number
}

function Range({ start, end }: { start: string | null; end: string | null }) {
  const { t } = useTranslation('carryover')
  return (
    <span className="font-mono text-ui-xs text-foreground-subtle">
      {t('modal.range', { start: formatDateIso(start, '--'), end: formatDateIso(end, '--') })}
    </span>
  )
}

export function CarryoverConfirmModal({
  open,
  onClose,
  onCarried,
  workItemId,
  itemKey,
  targetEndDate,
  source,
  targets,
  taskCount,
  unfinishedTaskCount,
}: CarryoverConfirmModalProps) {
  const { t } = useTranslation('carryover')
  const carry = useCarryOverWorkItem(workItemId)
  // One target is proposed; several must be chosen (CO-BR-19/20).
  const [chosenId, setChosenId] = useState<string | null>(
    targets.length === 1 ? targets[0].id : null,
  )
  const [submitError, setSubmitError] = useState<string | null>(null)
  const target = targets.find((it) => it.id === chosenId) ?? null

  async function accept() {
    if (!target) return
    setSubmitError(null)
    try {
      await carry.mutateAsync({
        expectedSourceIterationId: source.id,
        targetIterationId: target.id,
        targetEndDate,
      })
      onClose()
      onCarried?.()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('modal.submitError'))
    }
  }

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={t('modal.title')}
      icon={<CalendarClock size={18} />}
      width={560}
    >
      <ModalBody className="space-y-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-ui-sm">
          <dt className="text-foreground-subtle">{t('modal.story')}</dt>
          <dd className="font-mono text-foreground">{itemKey}</dd>
          <dt className="text-foreground-subtle">{t('modal.targetEndDate')}</dt>
          <dd className="font-mono text-foreground">{formatDateIso(targetEndDate, '--')}</dd>
          <dt className="text-foreground-subtle">{t('modal.tasks')}</dt>
          <dd className="text-foreground">
            {t('modal.taskSummary', { total: taskCount, unfinished: unfinishedTaskCount })}
          </dd>
        </dl>

        <div className="flex flex-wrap items-start gap-3 rounded border border-border-subtle bg-surface-subtle p-3">
          <div className="min-w-0 flex-1">
            <p className="text-ui-xs font-semibold text-foreground-subtle uppercase">
              {t('modal.from')}
            </p>
            <p className="truncate text-ui-sm font-semibold text-foreground">{source.name}</p>
            <Range start={source.startDate} end={source.endDate} />
          </div>
          <ArrowRight size={16} className="mt-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-ui-xs font-semibold text-foreground-subtle uppercase">
              {t('modal.to')}
            </p>
            {targets.length === 0 ? (
              <p role="status" className="text-ui-sm text-destructive">
                {t('modal.noDestination', { date: formatDateIso(targetEndDate, '--') })}
              </p>
            ) : targets.length === 1 ? (
              <>
                <p className="truncate text-ui-sm font-semibold text-foreground">
                  {targets[0].name}
                </p>
                <Range start={targets[0].startDate} end={targets[0].endDate} />
              </>
            ) : (
              <fieldset>
                <legend className="mb-1 text-ui-xs text-foreground-subtle">
                  {t('modal.chooseTarget')}
                </legend>
                {targets.map((it) => (
                  <label key={it.id} className="flex cursor-pointer items-center gap-2 py-0.5">
                    <input
                      type="radio"
                      name="carryover-target"
                      value={it.id}
                      checked={chosenId === it.id}
                      onChange={() => setChosenId(it.id)}
                    />
                    <span className="text-ui-sm text-foreground">{it.name}</span>
                    <Range start={it.startDate} end={it.endDate} />
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="justify-end">
        {submitError && (
          <span role="alert" className="mr-auto text-ui-sm text-destructive">
            {submitError}
          </span>
        )}
        <Button variant="outline" onClick={onClose} disabled={carry.isPending}>
          {t('modal.cancel')}
        </Button>
        <Button disabled={!target || carry.isPending} onClick={() => void accept()}>
          {t('modal.accept')}
        </Button>
      </ModalFooter>
    </AppModal>
  )
}
