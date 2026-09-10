/**
 * AddTestResultModal — Phase D (SRS §8). Adds a Result to a Test Case. Build, Date and Tester are
 * required (Save disabled otherwise, AC9); Test Case and Work Product are read-only display facts,
 * never fields (BR13 — the service snapshots `workItemId` server-side, nothing here can override
 * it). On save, the modal closes, the caller's list invalidates, and — SRS §8 / Story 7 AC5 — the
 * new Result's own Detail opens (`/test-result/$testResultId`, Phase E), the same
 * create-then-navigate shape `CreateTestCaseModal` already uses one level up.
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useCreateTestResult, useTestCase, type TestResult } from '@/features/test-cases/api'
import { VERDICT_LABEL } from '@/features/test-cases/model/test-result-columns'
import { useWorkItem } from '@/features/work-items/api'
import { useTeamOwnerOptions } from '@/features/teams/api'
import { todayIsoDate, EMPTY_VALUE } from '@/shared/lib/utils'
import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { FormField, ReadOnlyFieldValue } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { DateField } from '@/shared/ui/date-field'
import { OwnerSelectField } from '@/shared/ui/entity-select-field'
import { SearchableSelect } from '@/shared/ui/searchable-select'

interface Props {
  testCaseId: string
  projectId: string
  onClose: () => void
}

// F1: derived from the ONE VERDICT_LABEL (test-result-columns.tsx), not a second hardcoded list.
const VERDICT_OPTIONS = Object.keys(VERDICT_LABEL) as TestResult['verdict'][]

export function AddTestResultModal({ testCaseId, projectId, onClose }: Props) {
  const { t } = useTranslation('test-cases')
  const navigate = useNavigate()

  const { data: testCase } = useTestCase(testCaseId)
  // Work Product — display only (BR13); resolved from the Test Case's OWN current workItemId,
  // which is exactly what the server snapshots at create time.
  const { data: workItem } = useWorkItem(testCase?.workItemId ?? undefined)

  // Tester options — the SAME assignment-eligibility feed as Owner/Assigned To (BR8), scoped to
  // the Test Case's own inherited team.
  const { data: members = [] } = useTeamOwnerOptions(projectId, testCase?.teamId)

  const [build, setBuild] = useState('')
  const [runDate, setRunDate] = useState(todayIsoDate())
  const [verdict, setVerdict] = useState<(typeof VERDICT_OPTIONS)[number]>('pass')
  const [durationMinutes, setDurationMinutes] = useState('0')
  const [testerId, setTesterId] = useState('')
  const [notes, setNotes] = useState('')

  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const createResult = useCreateTestResult(testCaseId)
  const buildRef = useRef<HTMLInputElement>(null)

  const canSave = build.trim() !== '' && runDate !== '' && testerId !== ''

  async function submit() {
    if (!canSave) return
    setFormError(null)
    setSubmitting(true)
    try {
      const created = await createResult.mutateAsync({
        build: build.trim(),
        runDate,
        verdict,
        durationMinutes: Number(durationMinutes) || 0,
        testerId,
        notes: notes.trim() || undefined,
      })
      onClose()
      // SRS §8 / Story 7 AC5: "a new Result is added... and the new Test Result Detail opens."
      void navigate({ to: '/test-result/$testResultId', params: { testResultId: created.id } })
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('results.create.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppModal
      open
      onClose={onClose}
      title={t('results.create.title')}
      subtitle={t('results.create.subtitle')}
      width={520}
    >
      <ModalBody className="space-y-4">
        {formError && (
          <p role="alert" className="text-ui-sm text-destructive">
            {formError}
          </p>
        )}

        <FormField label={t('results.create.testCaseLabel')}>
          <ReadOnlyFieldValue>{testCase?.testCaseKey ?? ''}</ReadOnlyFieldValue>
        </FormField>

        <FormField label={t('fields.workProduct')}>
          <ReadOnlyFieldValue>{workItem?.itemKey ?? EMPTY_VALUE}</ReadOnlyFieldValue>
        </FormField>

        <div className="grid grid-cols-2 gap-4">
          <FormField label={t('results.create.buildLabel')} htmlFor="tr-build" required>
            <Input
              id="tr-build"
              ref={buildRef}
              autoFocus
              value={build}
              onChange={(e) => setBuild(e.target.value)}
              placeholder={t('results.create.buildPlaceholder')}
            />
          </FormField>

          <FormField label={t('results.create.dateLabel')} required>
            <DateField
              variant="field"
              value={runDate || null}
              ariaLabel={t('results.create.dateLabel')}
              onChange={(v) => setRunDate(v ?? '')}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField label={t('results.create.verdictLabel')}>
            <SearchableSelect
              variant="field"
              value={verdict}
              ariaLabel={t('results.create.verdictLabel')}
              options={VERDICT_OPTIONS.map((v) => ({ value: v, label: VERDICT_LABEL[v] }))}
              onChange={(v) => setVerdict((v as (typeof VERDICT_OPTIONS)[number]) || 'pass')}
            />
          </FormField>

          <FormField label={t('results.create.durationLabel')} htmlFor="tr-duration">
            <Input
              id="tr-duration"
              type="number"
              min={0}
              step={1}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
            />
          </FormField>
        </div>

        <OwnerSelectField
          id="tr-tester"
          label={t('results.create.testerLabel')}
          placeholder={t('results.create.testerPlaceholder')}
          value={testerId}
          onChange={setTesterId}
          members={members}
          required
        />

        <FormField label={t('results.create.notesLabel')} htmlFor="tr-notes">
          <Input id="tr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </ModalBody>

      <ModalFooter className="justify-end">
        <div className="flex gap-2">
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            {t('common:cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !canSave}>
            {submitting && <Loader2 size={11} className="animate-spin" />}
            {submitting ? t('results.create.saving') : t('results.create.saveButton')}
          </Button>
        </div>
      </ModalFooter>
    </AppModal>
  )
}
