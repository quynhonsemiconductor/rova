/**
 * WorkItemActionsMenu — the "More work item actions" kebab, new in SU-01.
 *
 * Two things this pins that a reviewer cannot see from the diff:
 *   • the menu holds ONLY `Split unfinished story` — nothing was moved into it from the header, and a
 *     later PR that quietly relocates Watch or Delete has to change this test on purpose;
 *   • it renders NOTHING rather than a disabled item when the verb is unavailable, matching Delete
 *     beside it ("a control that only refuses is noise").
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

  it('asks for no preview until the modal is opened', () => {
    // The kebab itself must not fetch: eligibility is a live read, and a detail page that previewed
    // every Story on mount would pay for an answer nobody requested.
    renderMenu()
    expect(useSplitPreview).not.toHaveBeenCalled()
  })

  it('opens the Split modal from the menu item', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More work item actions' }))
    fireEvent.click(screen.getByText('Split unfinished story'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Splitting US-1: Upgrade NX workspace to v21')).toBeInTheDocument()
    // The confirm is disabled because the PREVIEW has not landed in this fixture, so there is no draft
    // to confirm — not because the entry point decides anything about it.
    expect(screen.getByRole('button', { name: 'Split story' })).toBeDisabled()
  })
})
