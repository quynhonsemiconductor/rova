/**
 * The Test Result Revision History tab must opt into the Time / Actor / Action / Details layout
 * (SRS §9.4, US-97 TC-37) and carry its OWN subtitle (DE-18). Asserted through the tab itself: the
 * shared component's own tests never pass `actionLayout`.
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
    action: 'test_result.updated',
    changes: null,
    metadata: { subjectKey: 'TR-4' },
  },
]

vi.mock('@/features/test-cases/api', () => ({
  useTestResultActivity: () => ({ data: rows, isLoading: false }),
}))

import '@/shared/i18n/i18n'
import { HistoryTab } from './history-tab'

describe('Test Result HistoryTab', () => {
  it('TC-37: renders the action layout with the row keyed by its own record', () => {
    render(<HistoryTab testResultId="tr-4" />)

    for (const header of ['Time', 'Actor', 'Action', 'Details']) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
    expect(screen.queryByText('Revision')).not.toBeInTheDocument()
    expect(screen.getByText('TR-4')).toBeInTheDocument()
    expect(screen.getByText('Activity recorded for this Test Result.')).toBeInTheDocument()
  })
})
