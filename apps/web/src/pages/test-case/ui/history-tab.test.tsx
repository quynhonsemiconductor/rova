/**
 * The Test Case Revision History tab must opt into the Time / Actor / Action / Details layout
 * (SRS §6.4, US-93 TC-25). Asserted through the tab itself: the shared component's own tests never
 * pass `actionLayout`, so dropping the prop here would otherwise leave the suite green.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ActivityRow } from '@/entities/activity/ui/activity-history-tab'

const rows: ActivityRow[] = [
  {
    id: 'log-1',
    createdAt: '2026-10-16T09:00:00.000Z',
    actorId: 'u-actor',
    actorName: 'Linh Tran',
    action: 'test_case.created',
    changes: null,
    metadata: { subjectKey: 'TC-12', name: 'Login works' },
  },
]

vi.mock('@/features/test-cases/api', () => ({
  useTestCaseActivity: () => ({ data: rows, isLoading: false }),
}))

import '@/shared/i18n/i18n'
import { HistoryTab } from './history-tab'

describe('Test Case HistoryTab', () => {
  it('TC-25: renders the action layout with the row keyed by its own record', () => {
    render(<HistoryTab testCaseId="tc-1" />)

    for (const header of ['Time', 'Actor', 'Action', 'Details']) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
    expect(screen.queryByText('Revision')).not.toBeInTheDocument()
    expect(screen.getByText('TC-12')).toBeInTheDocument()
    expect(screen.getByText('Activity recorded for this Test Case.')).toBeInTheDocument()
  })
})
