/**
 * Revision History rows for a Test Case and a Test Result, in the mockup's Time / Actor / Action /
 * Details shape (SRS §6.4, §9.4; US-93 TC-25, US-97 TC-37).
 *
 * The server stores ids and adds the display values beside them in `metadata`
 * (`test-activity-enrichment.ts`): `subjectKey` (the row's own TC-/TR- key), `oldName`/`newName`
 * on a person field, `testerName` on a Result's creation. This file only words them — it never
 * prints an id a reader cannot review: a person whose name did not resolve reads "Unknown user".
 */
import type { TFunction } from 'i18next'
import type { ActivityActionRow, ActivityRow } from '@/entities/activity/ui/activity-history-tab'
import { activityFieldLabel, formatActivityValue } from '@/entities/work-item/model/activity'
import { formatDateIso } from '@/shared/lib/utils'
import { VERDICT_LABEL } from './test-result-columns'

/** Field → its label key in the `test-cases` namespace — the SAME words the detail pages use. */
const FIELD_LABEL_KEY: Record<string, string> = {
  name: 'columns.name',
  description: 'fields.description',
  objective: 'fields.objective',
  preconditions: 'fields.preconditions',
  validationInput: 'fields.validationInput',
  validationExpectedResult: 'fields.validationExpectedResult',
  postconditions: 'fields.postconditions',
  notes: 'fields.notes',
  type: 'fields.type',
  method: 'fields.method',
  priority: 'fields.priority',
  ownerId: 'fields.owner',
  assigneeId: 'fields.assignedTo',
  build: 'results.columns.build',
  runDate: 'results.columns.runDate',
  verdict: 'results.columns.verdict',
  durationMinutes: 'results.columns.duration',
  testerId: 'results.columns.tester',
}

const PERSON_FIELDS = new Set(['ownerId', 'assigneeId', 'testerId'])

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

function verdictLabel(value: unknown): string | null {
  const v = text(value)
  return v ? (VERDICT_LABEL[v as keyof typeof VERDICT_LABEL] ?? v) : null
}

/** One side of a change, worded for the reader. */
function sideValue(
  t: TFunction<'test-cases'>,
  field: string,
  value: unknown,
  name: unknown,
): string {
  if (value === null || value === undefined || value === '') return t('history.empty')
  if (PERSON_FIELDS.has(field)) return text(name) ?? t('history.unknownUser')
  if (field === 'verdict') return verdictLabel(value) ?? t('history.empty')
  if (field === 'method') return t(`methods.${String(value)}`, String(value))
  if (field === 'priority') return t(`priorities.${String(value)}`, String(value))
  // A Split's Work Product change carries the Story keys beside the ids (SU-07 AC4).
  return text(name) ?? formatActivityValue(value)
}

export function describeTestActivity(
  t: TFunction<'test-cases'>,
  log: ActivityRow,
): ActivityActionRow {
  const meta = log.metadata ?? {}
  const subjectKey = text(meta.subjectKey)

  switch (log.action) {
    case 'test_case.created':
      return { subjectKey, action: t('history.actions.testCaseCreated'), detail: text(meta.name) }
    case 'test_case.deleted':
      return { subjectKey, action: t('history.actions.testCaseDeleted'), detail: text(meta.name) }
    case 'test_result.created':
      return {
        subjectKey,
        action: t('history.actions.resultRecorded'),
        detail: t('history.resultRecorded', {
          tester: text(meta.testerName) ?? t('history.unknownUser'),
          verdict: verdictLabel(meta.verdict) ?? t('history.empty'),
          build: text(meta.build) ?? t('history.empty'),
          // Same `yyyy-MM-dd` the Results grid's Date cell shows; a date-only value is never shifted.
          date: formatDateIso(text(meta.runDate), t('history.empty')),
        }),
      }
    case 'test_result.deleted':
      return { subjectKey, action: t('history.actions.resultDeleted'), detail: null }
  }

  if (log.changes) {
    const { field, old, new: next } = log.changes
    const labelKey = FIELD_LABEL_KEY[field]
    const label = labelKey ? t(labelKey) : activityFieldLabel(log)
    const from = sideValue(t, field, old, meta.oldName)
    const to = sideValue(t, field, next, meta.newName)
    return {
      subjectKey,
      action: t('history.actions.changed', { field: label }),
      // Two sides that READ the same (a formatting-only rich-text edit, an edit past the preview
      // window, a pre-DE-18 row) state the change and stop — same rule as `describeActivity`.
      detail: from === to ? t('history.contentChanged') : t('history.change', { from, to }),
    }
  }

  return { subjectKey, action: activityFieldLabel(log), detail: null }
}
