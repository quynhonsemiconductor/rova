/** Carryover badge (CO-08/09) and the Export button's visibility (R4). */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { can } = vi.hoisted(() => ({ can: vi.fn() }))
vi.mock('@/features/access/api', () => ({ useProjectPermissions: () => ({ can }) }))
vi.mock('@/features/reporting/api', () => ({ downloadReportCsv: vi.fn() }))

import '@/shared/i18n/i18n'
import { CarryoverBadge } from './carryover-badge'
import { ReportExportButton } from './report-export-button'

describe('CarryoverBadge', () => {
  it('shows only non-zero counts with the transferred To Do', () => {
    render(
      <CarryoverBadge
        summary={{ carryIn: 0, carryOut: 2, transferredTodoHours: 7.5 }}
        onOpenReport={vi.fn()}
      />,
    )
    expect(screen.getByText('Carry Out 2')).toBeInTheDocument()
    expect(screen.queryByText(/Carry In/)).toBeNull()
    expect(screen.getByText(/7\.5h To Do/)).toBeInTheDocument()
  })

  it('opens the report', () => {
    const onOpenReport = vi.fn()
    render(
      <CarryoverBadge
        summary={{ carryIn: 1, carryOut: 0, transferredTodoHours: 0 }}
        onOpenReport={onOpenReport}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View report →' }))
    expect(onOpenReport).toHaveBeenCalled()
  })

  it('renders nothing without Carryover', () => {
    const { container } = render(<CarryoverBadge summary={null} onOpenReport={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ReportExportButton', () => {
  const request = { report: 'velocity' as const, projectId: 'p1', window: 5 as const }

  it('is shown to a holder of report:export', () => {
    can.mockImplementation((code: string) => code === 'report:export')
    render(<ReportExportButton request={request} />)
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
  })

  it('is hidden without report:export', () => {
    can.mockReturnValue(false)
    render(<ReportExportButton request={request} />)
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })
})
