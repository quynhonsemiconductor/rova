/**
 * Reports > Carryover (CO-10) — KPIs fixed while Direction filters rows, the empty state, and the
 * Direction control reporting upward.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { useCarryoverReport, useIterationOptions } = vi.hoisted(() => ({
  useCarryoverReport: vi.fn(),
  useIterationOptions: vi.fn(),
}))
vi.mock('@/features/reporting/api', () => ({ useCarryoverReport }))
vi.mock('@/features/iterations/api', () => ({ useIterationOptions }))
vi.mock('./report-export-button', () => ({ ReportExportButton: () => null }))

import '@/shared/i18n/i18n'
import { CarryoverReport } from './carryover-report'

const ITER = {
  id: 'B',
  name: 'Sprint B',
  iterationKey: null,
  state: 'planning',
  startDate: '2030-01-21',
  endDate: '2030-02-01',
  teamId: null,
  projectId: 'p1',
}

const ROW = {
  transitionId: 'e1',
  direction: 'in',
  storyId: 's1',
  storyKey: 'US-9',
  storyTitle: 'Carried story',
  fromIterationId: 'A',
  fromIterationName: 'Sprint A',
  toIterationId: 'B',
  toIterationName: 'Sprint B',
  movedAt: '2030-01-19T03:00:00.000Z',
  startDate: '2030-01-08',
  targetEndDate: '2030-01-25',
  estimateHours: 8,
  todoHours: 5,
  actualBefore: 3,
  actualAfter: 4,
}

function report(rows: (typeof ROW)[]) {
  return {
    context: {
      projectId: 'p1',
      projectName: 'NXP',
      teamId: null,
      teamName: 'All Teams',
      timeZone: 'UTC',
    },
    timebox: {
      iterationId: 'B',
      timeboxGroupId: null,
      name: 'Sprint B',
      startDate: null,
      endDate: null,
      iterationCount: 1,
    },
    direction: 'all',
    kpis: { carryIn: 1, carryOut: 2, transferredTodoHours: 5, carryoverRate: 33.3 },
    trend: [
      { iterationId: 'B', name: 'Sprint B', startDate: '2030-01-21', carryIn: 1, carryOut: 2 },
    ],
    rows,
  }
}

describe('CarryoverReport', () => {
  beforeEach(() => {
    useIterationOptions.mockReturnValue({ data: [ITER], isLoading: false, isError: false })
  })

  it('renders the four KPIs and the SRS-ordered row', () => {
    useCarryoverReport.mockReturnValue({ data: report([ROW]), isLoading: false, isError: false })
    render(
      <CarryoverReport
        projectId="p1"
        teamId={undefined}
        direction="all"
        onDirectionChange={vi.fn()}
      />,
    )
    expect(screen.getByText('33.3%')).toBeInTheDocument()
    expect(screen.getByText('US-9')).toBeInTheDocument()
    expect(screen.getByText('4h')).toBeInTheDocument()
    // The chart's accessible data table comes first; the rows table is the last twelve headers.
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
      .slice(-12)
    expect(headers.slice(0, 3)).toEqual(['Direction', 'Work Item', 'Name'])
    expect(headers.at(-1)).toBe('Actual After')
  })

  it('reports a Direction change upward without touching the KPIs', () => {
    const onDirectionChange = vi.fn()
    useCarryoverReport.mockReturnValue({ data: report([]), isLoading: false, isError: false })
    render(
      <CarryoverReport
        projectId="p1"
        teamId={undefined}
        direction="all"
        onDirectionChange={onDirectionChange}
      />,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Direction' }), {
      target: { value: 'out' },
    })
    expect(onDirectionChange).toHaveBeenCalledWith('out')
    expect(screen.getByText('No Carryover events for this Iteration.')).toBeInTheDocument()
    expect(screen.getByText('33.3%')).toBeInTheDocument()
  })
})
