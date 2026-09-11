/**
 * Test Case Detail Page (Phase 7, Phase C — SRS §6). Editable: the seven content fields, Type,
 * Method, Priority, Owner and Assigned To all write through `usePendingPatch` + `SaveCancelBar` —
 * the same shape `work-item-detail-page.tsx` already uses, not a rebuilt affordance.
 *
 * Project, Team, Last Verdict and Last Run stay `DetailReadonlyValue` — BR5/BR9, and
 * `UpdateTestCaseSchema` itself does not carry any of the four, so there is nothing for this page
 * to accidentally send even if it tried.
 *
 * Three tabs: `Details`, `Results` (Phase D) and `Revision History` (C6).
 */
import { useState } from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { FileText, FlaskConical, History } from 'lucide-react'
import { useDetailBack } from '@/shared/lib/use-detail-back'
import {
  useTestCaseByKey,
  useTestCaseTypes,
  useTestResults,
  useUpdateTestCase,
  type TestCase,
  type UpdateTestCaseInput,
} from '@/features/test-cases/api'
import { useWorkItem } from '@/features/work-items/api'
import { useProjectMemberOptions, useTeamOwnerOptions } from '@/features/teams/api'
import { useProjectPermissions } from '@/features/access/api'
import { DetailLayout, DetailTwoPane } from '@/shared/ui/detail/detail-layout'
import { DetailField, DetailReadonlyValue } from '@/shared/ui/detail/detail-field'
import { RichTextEditor } from '@/shared/ui/rich-text-editor'
import { VerdictBadge } from '@/features/test-cases/ui/verdict-badge'
import { ProjectCell } from '@/shared/ui/project-cell'
import { useRecordProject } from '@/shared/lib/deep-link-project'
import { PageSpinner } from '@/shared/ui/spinner'
import { SearchableSelect } from '@/shared/ui/searchable-select'
import { OwnerSelectField } from '@/shared/ui/entity-select-field'
import { AttachmentBlock } from '@/features/collaboration/ui/attachment-block'
import { usePendingPatch } from '@/shared/lib/hooks/use-pending-patch'
import { useSaveState } from '@/shared/lib/hooks/use-save-state'
import { SaveCancelBar } from '@/shared/ui/save-cancel-bar'
import { listResource } from '@/shared/lib/query/resource'
import { EMPTY_VALUE } from '@/shared/lib/utils'
import { entityDetailUrl } from '@/shared/lib/entity-link'
import { testCaseUnavailableReason } from './model/unavailable-reason'
import { TestCaseUnavailable } from './ui/test-case-unavailable'
import { HistoryTab } from './ui/history-tab'
import { ResultsTab } from './ui/results-tab'

type DetailTab = 'details' | 'results' | 'history'

export function TestCaseDetailPage() {
  const { t } = useTranslation('test-cases')
  const back = useDetailBack({ to: '/backlog' })
  const { testCaseKey } = useParams({ from: '/auth/test-case/$testCaseKey' })
  const [activeTab, setActiveTab] = useState<DetailTab>('details')

  const byKeyQuery = useTestCaseByKey(testCaseKey)
  const { data: testCaseByKey, isLoading, isError, error } = byKeyQuery

  // The parent Work Item, for the "Work Product" sidebar link — a Test Case Detail page carries
  // only the parent's ID (workItemId), never its key, so the link is resolved from the loaded row.
  const { data: workItem } = useWorkItem(testCaseByKey?.workItemId ?? undefined)
  const testCaseProject = useRecordProject(testCaseByKey?.projectId)

  const { can } = useProjectPermissions(testCaseByKey?.projectId)
  const readOnly = !can('test_case:edit')

  const updateMutation = useUpdateTestCase(testCaseByKey?.id ?? '')
  const { status: saveStatus, errorMsg: saveErrorMsg, wrap: wrapSave } = useSaveState()

  // Owner / Assigned To OFFER feed (BR8): team-scoped when the Test Case has a Team (its
  // INHERITED team, BR5 — read-only), project-wide otherwise. Same rule
  // `assignmentCandidates` enforces server-side; see detail-sidebar.tsx's own docblock for why
  // the current value is appended when the narrowed feed no longer contains it — Owner and
  // Assigned To each need this independently, since either can hold a value the narrowed
  // feed no longer does.
  const teamOwnerFeed = listResource(
    useTeamOwnerOptions(testCaseByKey?.projectId, testCaseByKey?.teamId),
  )
  const memberFeed = listResource(useProjectMemberOptions(testCaseByKey?.projectId))
  const ownerOptionsFor = (currentId: string | null | undefined) => {
    const scoped = teamOwnerFeed.rows
    if (!currentId || scoped.some((m) => m.userId === currentId)) return scoped
    const current = memberFeed.rows.find((m) => m.userId === currentId)
    return current ? [...scoped, current] : scoped
  }

  // BR17: the row's OWN current Type unions with the live selectable list, so a historical value
  // surviving its own removal still renders and is still selectable back to itself. A failed
  // fetch puts the select in read-only rather than rendering the row's Type as the ONLY option
  // (which would read as "this is the only Type" rather than "the feed failed") — same rule
  // `detail-sidebar.tsx`'s Feature select follows.
  const typeFeed = listResource(useTestCaseTypes(testCaseByKey?.projectId))
  const liveTypes = typeFeed.rows

  // D7: the Results tab badge reads the SAME collection the tab itself lists (no second
  // definition of one number) — the same shape the Work Item page's own Test Cases badge uses.
  const resultsForCountQuery = useTestResults(testCaseByKey?.id)
  const resultsForCount = listResource(resultsForCountQuery)
  const resultCount = resultsForCount.phase === 'error' ? null : resultsForCount.rows.length

  const {
    value: testCase,
    isDirty,
    saving,
    setField,
    save,
    cancel,
  } = usePendingPatch<TestCase, UpdateTestCaseInput>(
    testCaseByKey ?? null,
    testCaseByKey?.id,
    async (patch) => {
      await wrapSave(async () => {
        await updateMutation.mutateAsync(patch)
      })
    },
  )

  if (isLoading) return <PageSpinner />

  // N1: `testCase` (the hook's `value`) is null exactly when `testCaseByKey` is — checking both
  // narrows `testCase` from `TestCase | null` for every reference below, with no cast needed.
  if (!testCaseByKey || !testCase) {
    return (
      <TestCaseUnavailable
        reason={testCaseUnavailableReason(isError, error)}
        testCaseKey={testCaseKey}
        error={error}
        onBack={back}
      />
    )
  }

  const typeOptions = liveTypes.some((ty) => ty.name === testCase.type)
    ? liveTypes
    : [...liveTypes, { id: testCase.type, name: testCase.type }]

  const handleContentChange =
    (
      field:
        | 'description'
        | 'objective'
        | 'preconditions'
        | 'validationInput'
        | 'validationExpectedResult'
        | 'postconditions'
        | 'notes',
    ) =>
    (html: string) => {
      setField({ [field]: html || null })
    }

  return (
    <DetailLayout
      onBack={back}
      itemKey={testCase.testCaseKey}
      copyLink={{
        key: testCase.testCaseKey,
        name: testCase.name,
        url: entityDetailUrl('testCase', testCase.testCaseKey),
      }}
      title={testCase.name}
      tabs={[
        { key: 'details', label: t('detail.tabs.details'), icon: <FileText size={19} /> },
        {
          key: 'results',
          label: t('results.tabName'),
          icon: (
            <span className="flex items-center gap-1.5">
              <FlaskConical size={19} />
              <span className="text-ui-xs font-semibold tabular-nums">
                {resultCount ?? EMPTY_VALUE}
              </span>
            </span>
          ),
        },
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
              <RichTextEditor
                title={t('fields.description')}
                value={testCase.description}
                readOnly={readOnly}
                minHeight={100}
                onChange={handleContentChange('description')}
              />
              <RichTextEditor
                title={t('fields.objective')}
                value={testCase.objective}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('objective')}
              />
              <RichTextEditor
                title={t('fields.preconditions')}
                value={testCase.preconditions}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('preconditions')}
              />
              <RichTextEditor
                title={t('fields.validationInput')}
                value={testCase.validationInput}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('validationInput')}
              />
              <RichTextEditor
                title={t('fields.validationExpectedResult')}
                value={testCase.validationExpectedResult}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('validationExpectedResult')}
              />
              <RichTextEditor
                title={t('fields.postconditions')}
                value={testCase.postconditions}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('postconditions')}
              />
              <RichTextEditor
                title={t('fields.notes')}
                value={testCase.notes}
                readOnly={readOnly}
                minHeight={80}
                onChange={handleContentChange('notes')}
              />

              <AttachmentBlock
                subject={{ entityType: 'test_case', entityId: testCase.id }}
                readOnly={readOnly}
              />
            </>
          }
          sidebar={
            <div className="space-y-4">
              <DetailField label={t('fields.project')}>
                <ProjectCell
                  projectKey={testCaseProject?.projectKey}
                  projectName={testCaseProject?.projectName}
                />
              </DetailField>

              <DetailField label={t('fields.team')}>
                {/* NULL = "Project backlog" (SRS §5), read-only (BR5). */}
                <DetailReadonlyValue>
                  {testCase.teamName ?? t('fields.projectBacklog')}
                </DetailReadonlyValue>
              </DetailField>

              <DetailField label={t('fields.workProduct')}>
                {workItem ? (
                  <Link
                    to="/item/$itemKey"
                    params={{ itemKey: workItem.itemKey }}
                    className="font-mono text-ui-md text-primary-light underline-offset-2 hover:underline"
                  >
                    {workItem.itemKey}
                  </Link>
                ) : (
                  <DetailReadonlyValue>--</DetailReadonlyValue>
                )}
              </DetailField>

              <DetailField label={t('fields.type')}>
                <SearchableSelect
                  variant="field"
                  value={testCase.type}
                  readOnly={readOnly || typeFeed.isError}
                  ariaLabel={t('fields.type')}
                  options={typeOptions.map((ty) => ({ value: ty.name, label: ty.name }))}
                  onChange={(v) => setField({ type: v })}
                />
              </DetailField>

              <DetailField label={t('fields.method')}>
                <SearchableSelect
                  variant="field"
                  value={testCase.method}
                  readOnly={readOnly}
                  ariaLabel={t('fields.method')}
                  options={[
                    { value: 'manual', label: t('methods.manual') },
                    { value: 'automated', label: t('methods.automated') },
                  ]}
                  onChange={(v) => setField({ method: v as UpdateTestCaseInput['method'] })}
                />
              </DetailField>

              <DetailField label={t('fields.priority')}>
                <SearchableSelect
                  variant="field"
                  value={testCase.priority}
                  readOnly={readOnly}
                  ariaLabel={t('fields.priority')}
                  options={[
                    { value: 'low', label: t('priorities.low') },
                    { value: 'normal', label: t('priorities.normal') },
                    { value: 'high', label: t('priorities.high') },
                    { value: 'urgent', label: t('priorities.urgent') },
                  ]}
                  onChange={(v) => setField({ priority: v as UpdateTestCaseInput['priority'] })}
                />
              </DetailField>

              <OwnerSelectField
                label={t('fields.owner')}
                value={testCase.ownerId}
                onChange={(v) => setField({ ownerId: v || null })}
                members={ownerOptionsFor(testCase.ownerId)}
                disabled={readOnly}
              />

              <OwnerSelectField
                label={t('fields.assignedTo')}
                value={testCase.assigneeId}
                onChange={(v) => setField({ assigneeId: v || null })}
                members={ownerOptionsFor(testCase.assigneeId)}
                disabled={readOnly}
              />

              {/* BR9/BR10: Last Verdict / Last Run are read-only and maintained by the trigger —
                  never `--`, `Not Run` / `Not run yet` are the absent-value sentences here. */}
              <DetailField label={t('fields.lastVerdict')}>
                <VerdictBadge verdict={testCase.lastVerdict} />
              </DetailField>
              <DetailField label={t('fields.lastRun')}>
                <DetailReadonlyValue>
                  {testCase.lastRun ?? t('detail.notRunYet')}
                </DetailReadonlyValue>
              </DetailField>
            </div>
          }
        />
      )}

      {/* `results`/`history` are single-pane tab bodies, unlike `details` (which gets its padding
          from `DetailTwoPane`'s own `main` column) — this wrapper matches that same `bg-card p-6`
          inset so all three tabs sit at one consistent inset rather than `results`/`history`
          rendering flush against the page edge. */}
      {activeTab === 'results' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-card p-6">
          <ResultsTab
            testCaseId={testCase.id}
            projectId={testCase.projectId}
            teamId={testCase.teamId}
            workItemKey={workItem?.itemKey ?? null}
          />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-card p-6">
          <HistoryTab testCaseId={testCase.id} />
        </div>
      )}

      {/* Results/History have no `usePendingPatch` state of their own — only Details does — so the
          bar has no business appearing there under ANY circumstance. It used to render as a bare
          sibling after all three tab branches with no `activeTab` guard, so a dirty flag raised
          while on Details (whatever its cause) stayed visible across a tab switch, since nothing
          clears `pending` on `activeTab` change either. */}
      {activeTab === 'details' && (
        <SaveCancelBar
          visible={isDirty && !readOnly}
          saving={saving}
          errorMsg={saveStatus === 'error' ? saveErrorMsg : null}
          onSave={() => void save()}
          onCancel={cancel}
        />
      )}
    </DetailLayout>
  )
}
