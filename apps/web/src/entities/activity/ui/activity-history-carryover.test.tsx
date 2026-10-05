/**
 * Revision History — the Carryover entries (CO-07, ruling R12). The Carryover and the Manual Move must
 * read as DIFFERENT events, and both must name the Iterations captured at write time.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import '@/shared/i18n/i18n'
import { listResource } from '@/shared/lib/query/resource'
import { ActivityHistoryTab } from './activity-history-tab'

const base = {
  createdAt: '2030-01-20T10:00:00.000Z',
  actorId: 'u-1',
  actorName: 'Marcus Webb',
}

const rows = [
  {
    ...base,
    id: 'a-2',
    action: 'work_item.iteration_moved',
    changes: { field: 'iterationId', old: 'B', new: 'A' },
    metadata: { sourceIterationName: 'Sprint B', targetIterationName: 'Sprint A' },
  },
  {
    ...base,
    id: 'a-1',
    action: 'work_item.carried_over',
    changes: { field: 'iterationId', old: 'A', new: 'B' },
    metadata: {
      sourceIterationName: 'Sprint A',
      targetIterationName: 'Sprint B',
      targetEndDate: '2030-01-25',
    },
  },
  {
    ...base,
    id: 'a-3',
    action: 'work_item.iteration_moved',
    changes: { field: 'iterationId', old: 'A', new: null },
    metadata: { sourceIterationName: 'Sprint A', targetIterationName: null },
  },
]

describe('ActivityHistoryTab — Carryover entries', () => {
  it('labels a Carryover and a Manual Move distinctly, with actor and source/target', () => {
    render(
      <ActivityHistoryTab
        logs={listResource({ data: rows } as { data: typeof rows | undefined })}
        title="Revision History"
        subtitle="."
      />,
    )
    expect(
      screen.getByText('accepted Carryover: Sprint A → Sprint B · Target End 2030-01-25'),
    ).toBeInTheDocument()
    expect(screen.getByText('moved Iteration (manual): Sprint B → Sprint A')).toBeInTheDocument()
    expect(screen.getByText('moved Iteration (manual): Sprint A → Unscheduled')).toBeInTheDocument()
    expect(screen.getAllByText('Marcus Webb')).toHaveLength(3)
  })
})
