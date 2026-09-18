/**
 * BulkSplitStory — the Iteration Status entry point (SU-01 AC2).
 *
 * The assertion that matters most here is that the control is enabled by the SERVER'S `eligible` and
 * by nothing else. Every "disabled" case below is disabled for a reason the client is allowed to
 * know — no selection, several rows, not a Story, or the server has not said yes — and none of them
 * re-derives an eligibility rule. That distinction is the "picker narrower than the write" fault
 * class the plan risk register names, and it is invisible in a screenshot.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { useSplitPreview, useReleaseOptions, useSplitWorkItem, navigate } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  useReleaseOptions: vi.fn(() => ({
    data: [],
    isLoading: false,
    isPending: false,
    isError: false,
    error: undefined,
  })),
  // SU-06 — the modal this bar opens now holds the write.
  useSplitWorkItem: vi.fn(() => ({
    mutateAsync: vi.fn(() => new Promise(() => {})),
    isPending: false,
  })),
  navigate: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview, useSplitWorkItem }))
/**
 * ADDED BY SU-02. One test here opens the real `SplitStoryModal`, whose `[Continued]` panel now reads
 * the release REFERENCE feed — an unmocked `useQuery` with no `QueryClientProvider` throws, and this
 * file is about the Iteration Status bar, not about releases.
 */
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))
/** ADDED BY SU-06: the modal navigates on success, and `useNavigate` outside a router throws. */
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import '@/shared/i18n/i18n'
import { BulkSplitStory } from './bulk-split-story'
import type { RowSelection } from '@/shared/lib/hooks/use-row-selection'

const ROWS = [
  { id: 'wi-1', itemKey: 'US-1', title: 'Upgrade NX workspace to v21', type: 'story' },
  { id: 'wi-2', itemKey: 'DE-1', title: 'CI pipeline fails', type: 'defect' },
  { id: 'wi-3', itemKey: 'US-2', title: 'Second story', type: 'story' },
]

function selection(ids: string[]): RowSelection {
  return {
    selectedIds: new Set(ids),
    count: ids.length,
    clear: vi.fn(),
  } as unknown as RowSelection
}

function preview(eligible: boolean) {
  return {
    data: {
      eligible,
      ineligibleReason: eligible ? null : 'no_target',
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
const inFlight = {
  data: undefined,
  isLoading: true,
  isPending: true,
  isError: false,
  error: undefined,
}
const failed = {
  data: undefined,
  isLoading: false,
  isPending: false,
  isError: true,
  error: new Error('boom'),
}

const renderBulk = (ids: string[]) =>
  render(<BulkSplitStory selection={selection(ids)} rows={ROWS} />)

const splitButton = () => screen.getByRole('button', { name: 'Split' })

describe('BulkSplitStory', () => {
  beforeEach(() => {
    useSplitPreview.mockReset()
    useSplitPreview.mockReturnValue(preview(true))
  })

  it('is ENABLED for exactly one eligible Story (AC2)', () => {
    renderBulk(['wi-1'])
    expect(splitButton()).toBeEnabled()
  })

  it('carries no tooltip while enabled', () => {
    // An enabled control whose tooltip says it cannot be used is worse than no tooltip.
    renderBulk(['wi-1'])
    expect(splitButton()).not.toHaveAttribute('title')
  })

  it('is disabled with nothing selected', () => {
    renderBulk([])
    expect(splitButton()).toBeDisabled()
    expect(splitButton()).toHaveAttribute('title', 'Select exactly one User Story to split')
  })

  it('is disabled for MORE than one row — Bulk Split is out of scope (SRS §16)', () => {
    renderBulk(['wi-1', 'wi-3'])
    expect(splitButton()).toBeDisabled()
    expect(splitButton()).toHaveAttribute('title', 'Select exactly one User Story to split')
  })

  it('is disabled for a single non-Story row, and asks the server nothing', () => {
    renderBulk(['wi-2'])
    expect(splitButton()).toBeDisabled()
    // The narrowing at work: no request is enabled for a Defect, because none could succeed.
    expect(useSplitPreview).toHaveBeenCalledWith('wi-2', { enabled: false })
    // And the sentence is about the SELECTION, which the reader can act on — not "this story cannot
    // be split", which would be false of a Defect.
    expect(splitButton()).toHaveAttribute('title', 'Select exactly one User Story to split')
  })

  it('stays disabled for a non-Story even when a WARM eligible preview is cached', () => {
    // The regression this test was written for. `enabled: false` stops a query from FETCHING, but
    // TanStack still serves whatever is already cached for that key — so after one eligible Story has
    // been previewed, selecting a Defect read a warm `eligible: true` and the verb was offered. The
    // client narrowing therefore has to gate the CONTROL, not just the request.
    useSplitPreview.mockReturnValue(preview(true))
    renderBulk(['wi-2'])
    expect(splitButton()).toBeDisabled()
  })

  it('stays disabled for TWO rows even when a WARM eligible preview is cached', () => {
    useSplitPreview.mockReturnValue(preview(true))
    renderBulk(['wi-1', 'wi-3'])
    expect(splitButton()).toBeDisabled()
  })

  it('is disabled while the preview is IN FLIGHT — never optimistic', () => {
    useSplitPreview.mockReturnValue(inFlight)
    renderBulk(['wi-1'])
    expect(splitButton()).toBeDisabled()
  })

  it('is disabled when the preview FAILED — an error is not a yes', () => {
    useSplitPreview.mockReturnValue(failed)
    renderBulk(['wi-1'])
    expect(splitButton()).toBeDisabled()
  })

  it('is disabled when the SERVER says the Story is not eligible', () => {
    // The whole point: the client narrowed to "one Story" and would have offered it; the server's
    // `eligible: false` is what withholds the verb.
    useSplitPreview.mockReturnValue(preview(false))
    renderBulk(['wi-1'])
    expect(splitButton()).toBeDisabled()
    expect(splitButton()).toHaveAttribute('title', 'This story cannot be split')
  })

  it('NEVER renders `ineligibleReason` (SRS §11)', () => {
    useSplitPreview.mockReturnValue(preview(false))
    renderBulk(['wi-1'])
    expect(screen.queryByText(/no_target/i)).not.toBeInTheDocument()
    expect(splitButton().getAttribute('title')).not.toMatch(/no_target/i)
  })

  it('opens the modal on the selected Story', () => {
    renderBulk(['wi-1'])
    fireEvent.click(splitButton())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Splitting US-1: Upgrade NX workspace to v21')).toBeInTheDocument()
    // The confirm is RENDERED (SU-06 made it live), and its state is deliberately not asserted here:
    // this file's fixture carries `targets: []` / `targetIterationId: null`, so it would be disabled
    // for a fixture reason rather than a product one. Whether the control follows the draft is
    // `split-story-modal.test.tsx`'s subject, with a fixture that has a target.
    expect(screen.getByRole('button', { name: 'Split story' })).toBeInTheDocument()
  })

  it('renders no modal before the button is clicked', () => {
    renderBulk(['wi-1'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
