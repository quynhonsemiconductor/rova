/**
 * SplitStoryModal — the shell, from SU-01.
 *
 * Half of these tests assert an ABSENCE, and that is deliberate. SRS §11 forbids an explanation on a
 * disabled Split control, and the plan's §7 names absence as "the part of this feature most likely to
 * regress, because adding a helpful message feels like an improvement". A test that only checks what
 * IS rendered would pass after somebody helpfully added the reason.
 *
 * The confirm button being DISABLED is also an assertion about this PR specifically (§8 Q14): there is
 * no write path until SU-06, and a control wired to nothing would be worse than one that says so.
 *
 * EXTENDED BY SU-02 (2.5), not replaced: the 14 shell tests are the regression net, and the footer
 * summary + the release-feed mock are what SU-02 adds. Field-level behaviour lives in
 * `split-story-panel.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { useSplitPreview, useReleaseOptions } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  useReleaseOptions: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview }))
/**
 * The `[Continued]` panel reads the release REFERENCE feed (SU-02), so this file has to mock it now:
 * an unmocked `useQuery` in a test with no `QueryClientProvider` throws, and it would take all 14
 * shell tests with it.
 */
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))

import '@/shared/i18n/i18n'
import { SplitStoryModal } from './split-story-modal'

/** A preview as the server sends it — eligible, with the seeded Sprint 26.1 → 26.2 shape. */
function eligiblePreview() {
  return {
    eligible: true,
    ineligibleReason: null,
    story: {
      id: 'wi-1',
      itemKey: 'US-1',
      title: 'Upgrade NX workspace to v21',
      planEstimate: 5,
      scheduleState: 'in_progress',
      releaseId: 'rel-1',
      releaseName: 'Release 1',
      iterationId: 'iter-1',
      iterationName: 'Sprint 26.1',
      teamId: 'team-alpha',
      projectId: 'p-1',
    },
    targets: [
      {
        id: 'iter-3',
        name: 'Sprint 26.2',
        iterationKey: 'IT-3',
        state: 'planning',
        startDate: '2026-06-29',
        endDate: '2026-07-10',
      },
    ],
    defaults: {
      unfinishedTitle: '[Unfinished] Upgrade NX workspace to v21',
      continuedTitle: '[Continued] Upgrade NX workspace to v21',
      targetIterationId: 'iter-3',
    },
    tasks: [],
    defects: [],
    testCases: [],
  }
}

/** `useSplitPreview` returns a QUERY; the component wraps it with `valueResource`. */
function queryReady(data: unknown) {
  return { data, isLoading: false, isPending: false, isError: false, error: undefined }
}
const queryLoading = {
  data: undefined,
  isLoading: true,
  isPending: true,
  isError: false,
  error: undefined,
}
const queryError = {
  data: undefined,
  isLoading: false,
  isPending: false,
  isError: true,
  error: new Error('boom'),
}

function renderModal(onClose = vi.fn()) {
  render(
    <SplitStoryModal
      open
      onClose={onClose}
      workItemId="wi-1"
      itemKey="US-1"
      title="Upgrade NX workspace to v21"
    />,
  )
  return { onClose }
}

describe('SplitStoryModal', () => {
  beforeEach(() => {
    useSplitPreview.mockReset()
    useSplitPreview.mockReturnValue(queryReady(eligiblePreview()))
    useReleaseOptions.mockReset()
    useReleaseOptions.mockReturnValue(
      queryReady([
        {
          id: 'rel-1',
          projectId: 'p-1',
          releaseKey: 'RE-1',
          name: 'Release 1',
          status: 'planning',
        },
      ]),
    )
  })

  it('opens with the Story named in its title (AC1)', () => {
    renderModal()
    expect(screen.getByText('Splitting US-1: Upgrade NX workspace to v21')).toBeInTheDocument()
  })

  it('renders BOTH panel headings, and names the source Iteration on the [Unfinished] side', () => {
    renderModal()
    // The `[Unfinished]` Story stays in the source Iteration (BR-09), which is why the heading says
    // so rather than leaving the reader to infer it.
    expect(screen.getByText('[Unfinished] — stays in Sprint 26.1')).toBeInTheDocument()
    expect(screen.getByText('[Continued] — moves to a later iteration')).toBeInTheDocument()
  })

  it('renders `Split story` DISABLED, with a tooltip (§8 Q14 — no write path in this PR)', () => {
    renderModal()
    const confirm = screen.getByRole('button', { name: 'Split story' })
    expect(confirm).toBeDisabled()
    // A disabled button cannot explain itself; `title` is the affordance that does.
    expect(confirm).toHaveAttribute('title', 'Saving a split is not available yet')
  })

  it('closes on Cancel', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on the header × (AppModal behaviour, asserted so a hand-rolled shell cannot replace it)', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('is a real dialog — role, and a title that labels it', () => {
    // Proves the shared `AppModal` is in use rather than the mockup's `fixed inset-0` div: the focus
    // trap, scroll lock and aria wiring all come with this.
    renderModal()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a LOAD FAILURE, not an empty split, when the preview errors', () => {
    // `valueResource(...).value` is `undefined` both in flight and after a failure. A surface that
    // only checked for absence would render "no targets, nothing to distribute" as a measurement.
    useSplitPreview.mockReturnValue(queryError)
    renderModal()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Could not load the split')).toBeInTheDocument()
    // And it must NOT have rendered the panels as though the answer had arrived.
    expect(screen.queryByText(/\[Continued\]/)).not.toBeInTheDocument()
  })

  it('shows a loading line while in flight, distinct from both error and empty', () => {
    useSplitPreview.mockReturnValue(queryLoading)
    renderModal()
    expect(screen.getByText('Preparing the split…')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('gates the request on `open`, so the page behind it does not fetch a preview nobody asked for', () => {
    renderModal()
    expect(useSplitPreview).toHaveBeenCalledWith('wi-1', { enabled: true })
  })

  // ── The absences (SRS §11) ──────────────────────────────────────────────────

  it('NEVER renders `ineligibleReason`, even when the server sends one', () => {
    // The field exists for telemetry and tests. Every AC says the action is unavailable with no
    // explanatory message — so an ineligible preview must look like an ordinary one, not like a
    // refusal with a reason attached.
    useSplitPreview.mockReturnValue(
      queryReady({
        ...eligiblePreview(),
        eligible: false,
        ineligibleReason: 'no_target',
        targets: [],
        defaults: { ...eligiblePreview().defaults, targetIterationId: null },
      }),
    )
    renderModal()
    /**
     * CASE-SENSITIVE containment, changed by SU-02 from `queryByText(new RegExp(reason, 'i'))`.
     *
     * `unscheduled` is both an ineligibility reason and the product's own word for "no release",
     * which the `[Unfinished]` panel now renders — so the case-insensitive probe began matching
     * legitimate copy (and matching it twice, which `queryByText` throws on). The reasons are raw
     * snake_case wire values, so "the raw value never reaches the screen" is both the real claim and
     * a stricter one.
     */
    for (const reason of [
      'no_target',
      'not_a_story',
      'finished_state',
      'unscheduled',
      'not_editable',
    ]) {
      expect(document.body.textContent, reason).not.toContain(reason)
    }
  })

  it('renders NO validation text and NO warning copy', () => {
    renderModal()
    expect(screen.queryByText(/required/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot be/i)).not.toBeInTheDocument()
  })

  it('has no aria-invalid field while every default is valid', () => {
    renderModal()
    // `document.body`, not `render(...).container`: `AppModal` renders through a Radix Portal, so the
    // dialog is NOT inside the container RTL hands back. A container query here would pass
    // vacuously — and would keep passing now that SU-02 has added real validation.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.body.querySelector('[aria-invalid="true"]')).toBeNull()
  })

  // ── SU-02 2.5: the footer summary ───────────────────────────────────────────

  /** A preview carrying children, so the counts and the hour sums have something to report. */
  function previewWithChildren() {
    const base = eligiblePreview()
    return {
      ...base,
      tasks: [
        {
          id: 'ta-1',
          itemKey: 'TA-1',
          title: 'Bump the packages',
          state: 'completed',
          todoHours: 0,
          estimateHours: 4,
          actualHours: 4.5,
          defaultSide: 'unfinished',
        },
        {
          id: 'ta-2',
          itemKey: 'TA-2',
          title: 'Fix the build',
          state: 'in_progress',
          todoHours: 3,
          estimateHours: 5,
          actualHours: 2,
          defaultSide: 'continued',
        },
      ],
      defects: [
        {
          id: 'de-1',
          itemKey: 'DE-1',
          title: 'Watch mode crashes',
          scheduleState: 'defined',
          priority: 'high',
          explicitIterationId: null,
          explicitIterationName: null,
          defaultSide: 'continued',
        },
      ],
      testCases: [
        {
          id: 'tc-1',
          testCaseKey: 'TC-1',
          name: 'Build succeeds on a clean checkout',
          type: 'Functional',
          lastVerdict: 'pass',
          defaultSide: 'continued',
        },
      ],
    }
  }

  const estimateField = (side: 'unfinished' | 'continued') =>
    screen.getByLabelText('Plan Estimate (pts)', { selector: `#split-${side}-estimate` })

  it('summarises what the split carries, and the point comparison (BR-13)', () => {
    useSplitPreview.mockReturnValue(queryReady(previewWithChildren()))
    renderModal()
    expect(screen.getByText('2 Tasks · 1 Defects · 1 Test Cases')).toBeInTheDocument()
    expect(screen.getByText('6.5h Actual · 3h To Do')).toBeInTheDocument()
    // Both sides default to the original 5 (BR-12), so an untouched draft already reads +5.
    expect(screen.getByText('Points: 5 → 10 (+5)')).toBeInTheDocument()
  })

  it('reads the WARNING token on a difference and the SUCCESS token on none', () => {
    renderModal()
    expect(screen.getByText(/^Points:/)).toHaveClass('text-warning')
    fireEvent.change(estimateField('unfinished'), { target: { value: '2' } })
    fireEvent.change(estimateField('continued'), { target: { value: '3' } })
    expect(screen.getByText('Points: 5 → 5 (0)')).toHaveClass('text-success')
  })

  it('a difference blocks NOTHING and says nothing (BR-13/AC7)', () => {
    // The delta is a comparison, not a rule: it reaches no `disabled` and carries no message.
    renderModal()
    fireEvent.change(estimateField('continued'), { target: { value: '99' } })
    expect(screen.getByText('Points: 5 → 104 (+99)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows no summary while the preview is in flight', () => {
    useSplitPreview.mockReturnValue(queryLoading)
    renderModal()
    expect(screen.queryByText(/^Points:/)).toBeNull()
  })
})
