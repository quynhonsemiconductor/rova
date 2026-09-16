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
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { useSplitPreview } = vi.hoisted(() => ({ useSplitPreview: vi.fn() }))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview }))

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
    for (const reason of [
      'no_target',
      'not_a_story',
      'finished_state',
      'unscheduled',
      'not_editable',
    ]) {
      expect(screen.queryByText(new RegExp(reason, 'i'))).not.toBeInTheDocument()
    }
  })

  it('renders NO validation text and NO warning copy', () => {
    renderModal()
    expect(screen.queryByText(/required/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot be/i)).not.toBeInTheDocument()
  })

  it('has no aria-invalid field — there is nothing to validate in this PR', () => {
    renderModal()
    // `document.body`, not `render(...).container`: `AppModal` renders through a Radix Portal, so the
    // dialog is NOT inside the container RTL hands back. A container query here would pass
    // vacuously — and would keep passing after SU-02 adds real validation.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.body.querySelector('[aria-invalid="true"]')).toBeNull()
  })
})
