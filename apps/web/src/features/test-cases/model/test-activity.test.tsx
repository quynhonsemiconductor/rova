/**
 * Test Case / Test Result Revision History wording (US-93 TC-25, US-97 TC-37), rendered through
 * the shared `ActivityHistoryTab` exactly as both history tabs mount it.
 *
 * The defects were all things a reader could SEE — a Tester change printing a uuid, a Result
 * history with no first row, no record key, Action and Details fused into one sentence — so the
 * assertions are on rendered text, with the negatives that make each fix more than additive.
 */
import { describe, expect, it } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import { listResource } from '@/shared/lib/query/resource'
import { ActivityHistoryTab, type ActivityRow } from '@/entities/activity/ui/activity-history-tab'
import { activityFieldLabel } from '@/entities/work-item/model/activity'
import { useTestActivityLayout } from './use-test-activity-layout'
import '@/shared/i18n/i18n'

const TESTER_A = '0190a1b2-0000-7000-8000-00000000000a'
const TESTER_B = '0190a1b2-0000-7000-8000-00000000000b'

function row(over: Partial<ActivityRow>): ActivityRow {
  return {
    id: 'log-1',
    createdAt: '2026-10-16T09:00:00.000Z',
    actorId: 'u-actor',
    actorName: 'Linh Tran',
    action: 'test_result.updated',
    changes: null,
    metadata: { subjectKey: 'TR-4' },
    ...over,
  }
}

function renderHistory(rows: ActivityRow[]) {
  const { result } = renderHook(() => useTestActivityLayout())
  return render(
    <ActivityHistoryTab
      logs={listResource({ data: rows, isLoading: false })}
      title="Revision History"
      subtitle="Activity recorded for this Test Result."
      actionLayout={result.current}
    />,
  )
}

describe('Test activity history', () => {
  it('TC-25: renders the mockup columns, not the Revision / Description grid', () => {
    renderHistory([row({})])

    for (const header of ['Time', 'Actor', 'Action', 'Details']) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
    expect(screen.queryByText('Revision')).not.toBeInTheDocument()
  })

  it('TC-25: each row names its own record ahead of the detail', () => {
    renderHistory([
      row({
        id: 'a',
        action: 'test_case.created',
        metadata: { subjectKey: 'TC-12', name: 'Login works' },
      }),
    ])

    expect(screen.getByText('TC-12')).toBeInTheDocument()
    expect(screen.getByText('created Test Case')).toBeInTheDocument()
    expect(screen.getByText('Login works')).toBeInTheDocument()
  })

  it('TC-37: the creation row reads "Tester recorded Verdict for build X on Date"', () => {
    renderHistory([
      row({
        action: 'test_result.created',
        metadata: {
          subjectKey: 'TR-4',
          testerName: 'Minh Pham',
          verdict: 'fail',
          build: '2026.10.16.1',
          runDate: '2026-10-16',
          testerId: TESTER_A,
        },
      }),
    ])

    expect(screen.getByText('recorded Result')).toBeInTheDocument()
    expect(
      screen.getByText('Minh Pham recorded Fail for build 2026.10.16.1 on 2026-10-16'),
    ).toBeInTheDocument()
  })

  it('TC-37: a Tester change reads as names — the stored uuids never reach the screen', () => {
    renderHistory([
      row({
        changes: { field: 'testerId', old: TESTER_A, new: TESTER_B },
        metadata: { subjectKey: 'TR-4', oldName: 'Minh Pham', newName: 'Lan Vo' },
      }),
    ])

    expect(screen.getByText('changed Tester')).toBeInTheDocument()
    expect(screen.getByText('Minh Pham → Lan Vo')).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(TESTER_A))).not.toBeInTheDocument()
    expect(screen.queryByText(new RegExp(TESTER_B))).not.toBeInTheDocument()
  })

  it('a person whose name did not resolve reads "Unknown user", never an id', () => {
    renderHistory([
      row({
        changes: { field: 'ownerId', old: null, new: TESTER_A },
        metadata: { subjectKey: 'TC-12', oldName: null, newName: null },
      }),
    ])

    expect(screen.getByText('changed Owner')).toBeInTheDocument()
    expect(screen.getByText('(empty) → Unknown user')).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(TESTER_A))).not.toBeInTheDocument()
  })

  it('words enum values and field names the way the detail page labels them', () => {
    renderHistory([
      row({ id: 'v', changes: { field: 'verdict', old: 'pass', new: 'blocked' } }),
      row({
        id: 'vi',
        changes: { field: 'validationInput', old: 'a', new: 'b' },
        metadata: { subjectKey: 'TC-12' },
      }),
    ])

    expect(screen.getByText('Pass → Blocked')).toBeInTheDocument()
    expect(screen.getByText('changed Validation Input')).toBeInTheDocument()
  })

  it('two sides that read the same state the change and stop', () => {
    renderHistory([row({ changes: { field: 'notes', old: null, new: null } })])

    expect(screen.getByText('Content changed')).toBeInTheDocument()
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
  })

  it('an action this file does not word falls back to the shared label, keyed but detail-free', () => {
    const log = row({ action: 'test_result.archived', changes: null })
    renderHistory([log])

    expect(screen.getByText('TR-4')).toBeInTheDocument()
    expect(screen.getByText(activityFieldLabel(log))).toBeInTheDocument()
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
  })
})
