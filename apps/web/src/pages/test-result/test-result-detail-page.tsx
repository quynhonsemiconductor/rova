/**
 * Test Result Detail Page (Phase 7, Phase E — SRS §9). Editable: Build, Verdict, Duration, Notes,
 * Date and Tester write through `usePendingPatch` + `SaveCancelBar` — the same shape
 * `test-case-detail-page.tsx` already uses one level up.
 *
 * Test Case and Work Product stay `ReadOnlyFieldValue` — BR13, and `UpdateTestResultSchema` itself
 * does not carry either, so there is nothing for this page to accidentally send even if it tried.
 *
 * Two tabs: `Details` and `Revision History`. Back walks the real history stack (`useDetailBack`),
 * falling back to the parent Test Case's detail route when there is nowhere to walk back to (a
 * deep link) — never a hardcoded forward `navigate()`, which pushes a new stack entry instead of
 * consuming one and corrupts a SECOND Back from wherever this page led to.
 */
import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { FileText, History } from 'lucide-react'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import {
  useTestResult,
  useTestCase,
  useUpdateTestResult,
  type TestResult,
  type UpdateTestResultInput,
} from '@/features/test-cases/api'
import { VERDICT_LABEL } from '@/features/test-cases/model/test-result-columns'
import { useWorkItem } from '@/features/work-items/api'
import { useTeamOwnerOptions, useProjectMemberOptions } from '@/features/teams/api'
import { useProjectPermissions } from '@/features/access/api'
import { DetailLayout, DetailTwoPane } from '@/shared/ui/detail/detail-layout'
import { DetailField, DetailFieldPair, DetailReadonlyValue } from '@/shared/ui/detail/detail-field'
import { ReadOnlyFieldValue, FormField } from '@/shared/ui/form-field'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { DateField } from '@/shared/ui/date-field'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { OwnerSelectField } from '@/shared/ui/entity-select-field'
import { VerdictBadge } from '@/features/test-cases/ui/verdict-badge'
import { AttachmentBlock } from '@/features/collaboration/ui/attachment-block'
import { PageSpinner } from '@/shared/ui/spinner'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { useSaveState } from '@/shared/lib/hooks/use-save-state'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { listResource } from '@/shared/lib/query/resource'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { testResultUnavailableReason } from './model/unavailable-reason'
import { TestResultUnavailable } from './ui/test-result-unavailable'
import { HistoryTab } from './ui/history-tab'

type DetailTab = 'details' | 'history'

// F1: derived from the ONE VERDICT_LABEL (test-result-columns.tsx), not a second hardcoded list.
const VERDICT_OPTIONS = Object.keys(VERDICT_LABEL) as TestResult['verdict'][]

export function TestResultDetailPage() {
  const { t } = useTranslation('test-cases')
  const { testResultId } = useParams({ from: '/auth/test-result/$testResultId' })
  const [activeTab, setActiveTab] = useState<DetailTab>('details')

  const resultQuery = useTestResult(testResultId)
  const { data: result, isLoading, isError, error } = resultQuery

  // The owning Test Case, for the sidebar's read-only "Test Case" link and its Team (Tester feed).
  const { data: testCase } = useTestCase(result?.testCaseId)
  const { data: workItem } = useWorkItem(result?.workItemId ?? undefined)

  // Walks the REAL history stack (`useDetailBack`), like every other detail page — this page used
  // to call `navigate()` directly instead, which PUSHES a new forward entry rather than consuming
  // one. That left a duplicate Test Case entry in the stack, so a second Back (after landing back
  // on Test Case Detail) walked to the wrong place: this page's own previous entry (itself), not
  // Work Item Detail. The fallback varies with `testCase` — recomputed each render, not a
  // conditional hook call — matching what the old hardcoded `navigate()` already targeted.
  const back = useDetailBack(
    testCase
      ? { to: '/test-case/$testCaseKey', params: { testCaseKey: testCase.testCaseKey } }
      : { to: '/backlog' },
  )

  const { can } = useProjectPermissions(result?.projectId)
  const readOnly = !can('test_result:edit')

  const updateMutation = useUpdateTestResult(result?.id ?? '')
  const { status: saveStatus, errorMsg: saveErrorMsg, wrap: wrapSave } = useSaveState()

  // Tester OFFER feed (BR8): same team-scoped rule Owner/Assigned To/Create-modal Tester use —
  // scoped to the Test Case's own inherited team, with the current value appended when the
  // narrowed feed no longer contains it (same reasoning `test-case-detail-page.tsx`'s
  // `ownerOptionsFor` already uses).
  const teamTesterFeed = listResource(useTeamOwnerOptions(testCase?.projectId, testCase?.teamId))
  const memberFeed = listResource(useProjectMemberOptions(testCase?.projectId))
  const testerOptions = (() => {
    const scoped = teamTesterFeed.rows
    const currentId = result?.testerId
    if (!currentId || scoped.some((m) => m.userId === currentId)) return scoped
    const current = memberFeed.rows.find((m) => m.userId === currentId)
    return current ? [...scoped, current] : scoped
  })()

  const {
    value: testResult,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<TestResult, UpdateTestResultInput>(
    result ?? null,
    result?.id,
    async (patch) => {
      await wrapSave(async () => {
        await updateMutation.mutateAsync(patch)
      })
    },
  )

  if (isLoading) return <PageSpinner />

  // N1: `testResult` (the hook's `value`) is null exactly when `result` is — checking both narrows
  // `testResult` from `TestResult | null` for every reference below, with no cast needed.
  if (!result || !testResult) {
    return (
      <TestResultUnavailable
        reason={testResultUnavailableReason(isError, error)}
        error={error}
        onBack={back}
      />
    )
  }

  return (
    <DetailLayout
      onBack={back}
      itemKey={testResult.testResultKey}
      title={testResult.build}
      tabs={[
        { key: 'details', label: t('detail.tabs.details'), icon: <FileText size={19} /> },
        { key: 'history', label: t('detail.tabs.history'), icon: <History size={19} /> },
      ]}
      activeTab={activeTab}
      onTabChange={(k) => setActiveTab(k as DetailTab)}
    >
      {activeTab === 'details' && (
        <DetailTwoPane
          sidebarTitle={t('detail.metadataTitle')}
          main={
            <>
              <FormField label={t('results.create.buildLabel')} htmlFor="tr-build">
                <Input
                  id="tr-build"
                  value={testResult.build}
                  readOnly={readOnly}
                  onChange={(e) => setField({ build: e.target.value })}
                />
              </FormField>

              <FormField label={t('results.create.verdictLabel')}>
                <SearchableSelect
                  variant="field"
                  value={testResult.verdict}
                  readOnly={readOnly}
                  ariaLabel={t('results.create.verdictLabel')}
                  options={VERDICT_OPTIONS.map((v) => ({ value: v, label: VERDICT_LABEL[v] }))}
                  onChange={(v) => setField({ verdict: v as UpdateTestResultInput['verdict'] })}
                />
              </FormField>

              <FormField label={t('results.create.notesLabel')} htmlFor="tr-notes">
                <Textarea
                  id="tr-notes"
                  rows={5}
                  value={testResult.notes ?? ''}
                  readOnly={readOnly}
                  onChange={(e) => setField({ notes: e.target.value || null })}
                />
              </FormField>

              <AttachmentBlock
                subject={{ entityType: 'test_result', entityId: testResult.id }}
                readOnly={readOnly}
              />
            </>
          }
          sidebar={
            <div className="space-y-4">
              <DetailField label={t('results.create.dateLabel')}>
                <DateField
                  variant="field"
                  value={testResult.runDate}
                  readOnly={readOnly}
                  ariaLabel={t('results.create.dateLabel')}
                  onChange={(v) => setField({ runDate: v ?? undefined })}
                />
              </DetailField>

              <OwnerSelectField
                label={t('results.create.testerLabel')}
                value={testResult.testerId}
                onChange={(v) => v && setField({ testerId: v })}
                members={testerOptions}
                disabled={readOnly}
              />

              {/* BR13: read-only forever — `UpdateTestResultSchema` omits both fields. */}
              <DetailField label={t('results.create.testCaseLabel')}>
                <ReadOnlyFieldValue>{testCase?.testCaseKey ?? EMPTY_VALUE}</ReadOnlyFieldValue>
              </DetailField>
              <DetailField label={t('fields.workProduct')}>
                <ReadOnlyFieldValue>{workItem?.itemKey ?? EMPTY_VALUE}</ReadOnlyFieldValue>
              </DetailField>

              <DetailFieldPair>
                <DetailField label={t('results.create.durationLabel')}>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={String(testResult.durationMinutes ?? 0)}
                    readOnly={readOnly}
                    onChange={(e) =>
                      setField({ durationMinutes: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </DetailField>
                <DetailField label={t('fields.lastVerdict')}>
                  <DetailReadonlyValue>
                    <VerdictBadge verdict={testResult.verdict} />
                  </DetailReadonlyValue>
                </DetailField>
              </DetailFieldPair>
            </div>
          }
        />
      )}

      {/* `history` is a single-pane tab body, unlike `details` (which gets its padding from
          `DetailTwoPane`'s own `main` column) — this wrapper matches that same `bg-card p-6` inset,
          the identical fix `test-case-detail-page.tsx` already applies to its own `results`/
          `history` branches. */}
      {activeTab === 'history' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-card p-6">
          <HistoryTab testResultId={testResult.id} />
        </div>
      )}

      <SaveCancelBar
        visible={isDirty && !readOnly}
        saving={saving}
        errorMsg={saveStatus === 'error' ? saveErrorMsg : null}
        onSave={() => void save()}
        onCancel={cancel}
      />
    </DetailLayout>
  )
}
