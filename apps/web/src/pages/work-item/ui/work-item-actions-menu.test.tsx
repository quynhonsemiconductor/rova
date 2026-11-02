/**
 * WorkItemActionsMenu — the "More work item actions" kebab, new in SU-01.
 *
 * Two things this pins that a reviewer cannot see from the diff:
 *   • the menu holds ONLY `Split unfinished story` — nothing was moved into it from the header, and a
 *     later PR that quietly relocates Watch or Delete has to change this test on purpose;
 *   • it renders NOTHING for a non-Story or without `work_item:edit`, matching Delete beside it;
 *   • for an editable Story the item is DISABLED unless the server's preview says `eligible`
 *     (SU-01 AC4–AC6, BA retest TC-39).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { useSplitPreview, useSplitWorkItem, useReleaseOptions, navigate } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  // SU-06 — the modal this kebab opens now holds the write path, so the module mock has to carry it.
  useSplitWorkItem: vi.fn(() => ({
    mutateAsync: vi.fn(() => new Promise(() => {})),
    isPending: false,
  })),
  useReleaseOptions: vi.fn(() => ({
    data: [],
    isLoading: false,
    isPending: false,
    isError: false,
    error: undefined,
  })),
  navigate: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview, useSplitWorkItem }))
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import '@/shared/i18n/i18n'
import { WorkItemActionsMenu } from './work-item-actions-menu'

/** A settled preview. The kebab reads only `eligible`; the rest is what the modal renders. */
function previewResult(eligible: boolean) {
  return {
    data: {
      eligible,
      ineligibleReason: eligible ? null : 'finished_state',
      story: {
        id: 'wi-1',
        itemKey: 'US-1',
        title: 'Upgrade NX workspace to v21',
        planEstimate: 5,
        scheduleState: 'in_progress',
        releaseId: null,
        releaseName: null,
        iterationId: 'iter-1',
        iterationName: 'Sprint 26.1',
        teamId: 'team-alpha',
        projectId: 'p-1',
      },
      targets: [],
      defaults: {
        unfinishedTitle: '[Unfinished] Upgrade NX workspace to v21',
        continuedTitle: '[Continued] Upgrade NX workspace to v21',
        targetIterationId: null,
      },
      tasks: [],
      defects: [],
      testCases: [],
    },
    isLoading: false,
    isPending: false,
    isError: false,
    error: undefined,
  }
}

function renderMenu(
  overrides: Partial<{ type: string; canEdit: boolean }> = {},
): ReturnType<typeof render> {
  return render(
    <WorkItemActionsMenu
      workItemId="wi-1"
      itemKey="US-1"
      title="Upgrade NX workspace to v21"
      type={overrides.type ?? 'story'}
      canEdit={overrides.canEdit ?? true}
    />,
  )
}

describe('WorkItemActionsMenu', () => {
  beforeEach(() => {
    useSplitPreview.mockReset()
    useSplitPreview.mockReturnValue({
      data: undefined,
      isLoading: true,
      isPending: true,
      isError: false,
      error: undefined,
    })
  })

  it('renders the kebab for an editable Story (AC1)', () => {
    renderMenu()
    expect(screen.getByRole('button', { name: 'More work item actions' })).toBeInTheDocument()
  })

  it('holds ONLY `Split unfinished story`', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More work item actions' }))

    expect(screen.getByText('Split unfinished story')).toBeInTheDocument()
    // Nothing was moved in from the header. If a later PR relocates one of these, it must edit this
    // assertion deliberately rather than inheriting a passing test.
    expect(screen.queryByText(/^Watch$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Delete$/)).not.toBeInTheDocument()
  })

  it('renders NOTHING for a Task (BR-01 — only a Story is splittable)', () => {
    const { container } = renderMenu({ type: 'task' })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders NOTHING for a Defect', () => {
    const { container } = renderMenu({ type: 'defect' })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders NOTHING without `work_item:edit` — absent, not disabled', () => {
    const { container } = renderMenu({ canEdit: false })
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps the item DISABLED while eligibility is in flight (SU-01 AC4–AC6)', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More work item actions' }))
    expect(screen.getByRole('button', { name: 'Split unfinished story' })).toBeDisabled()
  })

  it('keeps the item DISABLED, with no message, when the server says ineligible (TC-39)', () => {
    useSplitPreview.mockReturnValue(previewResult(false))
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More work item actions' }))

    const item = screen.getByRole('button', { name: 'Split unfinished story' })
    expect(item).toBeDisabled()
    expect(item).not.toHaveAttribute('title')
    fireEvent.click(item)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks for no preview when the kebab does not render', () => {
    renderMenu({ canEdit: false })
    expect(useSplitPreview).toHaveBeenCalledWith('wi-1', { enabled: false })
  })

  it('opens the Split modal from the menu item once the server says eligible', () => {
    useSplitPreview.mockReturnValue(previewResult(true))
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More work item actions' }))
    fireEvent.click(screen.getByText('Split unfinished story'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Splitting US-1: Upgrade NX workspace to v21')).toBeInTheDocument()
    // The confirm is disabled because this fixture offers no target, so there is no valid draft to
    // confirm — the modal's own rule, not the entry point's.
    expect(screen.getByRole('button', { name: 'Split story' })).toBeDisabled()
  })
})
