/**
 * SplitStoryPanel — which fields each side owns, and the wordless invalid state (SU-02).
 *
 * Rendered THROUGH `SplitStoryModal` rather than in isolation, deliberately: the claims worth making
 * here are about the wiring — that a keystroke reaches the reducer and comes back as `aria-invalid`
 * on that field and no other, and that `Split story` stays disabled the whole time — and a panel
 * mounted on its own with a hand-built draft would prove none of it.
 *
 * EVERY ABSENCE IS QUERIED AGAINST `document.body`, NOT `render().container`. `AppModal` renders
 * through a Radix Portal, so the dialog is not inside the container RTL hands back and a
 * container-scoped absence assertion passes VACUOUSLY. SU-01 shipped exactly that mistake in its
 * `aria-invalid` test and fixed it the same way; this file is the one that would have inherited it,
 * because SU-02 is where real validation arrives.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const { useSplitPreview, useReleaseOptions } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  useReleaseOptions: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview }))
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))

import '@/shared/i18n/i18n'
import { SplitStoryModal } from './split-story-modal'

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
      {
        id: 'iter-4',
        name: 'Sprint 26.3',
        iterationKey: 'IT-4',
        state: 'planning',
        startDate: '2026-07-13',
        endDate: '2026-07-24',
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

function queryReady(data: unknown) {
  return { data, isLoading: false, isPending: false, isError: false, error: undefined }
}

function renderModal() {
  render(
    <SplitStoryModal
      open
      onClose={vi.fn()}
      workItemId="wi-1"
      itemKey="US-1"
      title="Upgrade NX workspace to v21"
    />,
  )
}

/** The two panels are `<section aria-labelledby>`, i.e. named regions — the natural scope. */
const unfinishedPanel = () => screen.getByRole('region', { name: /\[Unfinished\]/ })
const continuedPanel = () => screen.getByRole('region', { name: /\[Continued\]/ })
const confirmButton = () => screen.getByRole('button', { name: 'Split story' })

describe('SplitStoryPanel', () => {
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
        {
          id: 'rel-2',
          projectId: 'p-1',
          releaseKey: 'RE-2',
          name: 'Release 2',
          status: 'planning',
        },
      ]),
    )
  })

  // ── 2.2 the `[Unfinished]` side ─────────────────────────────────────────────

  it('seeds both titles and both estimates from the preview (BR-12, §8 Q10)', () => {
    renderModal()
    expect(within(unfinishedPanel()).getByLabelText('Title')).toHaveValue(
      '[Unfinished] Upgrade NX workspace to v21',
    )
    expect(within(continuedPanel()).getByLabelText('Title')).toHaveValue(
      '[Continued] Upgrade NX workspace to v21',
    )
    expect(within(unfinishedPanel()).getByLabelText('Plan Estimate (pts)')).toHaveValue('5')
    expect(within(continuedPanel()).getByLabelText('Plan Estimate (pts)')).toHaveValue('5')
  })

  it('renders `[Unfinished]` Release / Iteration / Schedule State as VALUES, not as controls', () => {
    // BR-09/BR-10 fix all three by rule. The mockup draws them as disabled `<select>`s; a disabled
    // control says "there is a choice here, just not for you", which is false.
    renderModal()
    const panel = unfinishedPanel()
    expect(within(panel).queryByRole('combobox')).toBeNull()
    expect(within(panel).getByText('Unscheduled')).toBeInTheDocument()
    expect(within(panel).getByText('Sprint 26.1')).toBeInTheDocument()
    expect(within(panel).getByText('Accepted')).toBeInTheDocument()
  })

  it('has NO disabled control anywhere in the panels — a disabled field is not how read-only is said', () => {
    renderModal()
    // `Split story` is disabled (§8 Q14) and lives in the footer, so the panels must hold none.
    expect(unfinishedPanel().querySelector('[disabled]')).toBeNull()
    expect(continuedPanel().querySelector('[disabled]')).toBeNull()
  })

  it('leaves Title and Plan Estimate EDITABLE on the `[Unfinished]` side', () => {
    renderModal()
    const panel = unfinishedPanel()
    const title = within(panel).getByLabelText('Title')
    fireEvent.change(title, { target: { value: 'Historical record' } })
    expect(title).toHaveValue('Historical record')
    const estimate = within(panel).getByLabelText('Plan Estimate (pts)')
    fireEvent.change(estimate, { target: { value: '2' } })
    expect(estimate).toHaveValue('2')
  })

  // ── 2.4 AC2's cleared relationship ──────────────────────────────────────────

  it('states on the `[Unfinished]` side that the Feature/parent link is cleared (AC2)', () => {
    renderModal()
    const panel = unfinishedPanel()
    expect(within(panel).getByText('Feature')).toBeInTheDocument()
    expect(within(panel).getByText('Cleared by the split')).toBeInTheDocument()
    // A fact about the placeholder, not a caution — and it belongs to that side only.
    expect(within(continuedPanel()).queryByText('Cleared by the split')).toBeNull()
  })

  // ── 2.3 the `[Continued]` side ──────────────────────────────────────────────

  it('makes all five fields editable on the `[Continued]` side', () => {
    renderModal()
    const panel = continuedPanel()
    expect(within(panel).getByLabelText('Title')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Plan Estimate (pts)')).toBeInTheDocument()
    // Release, Iteration and Schedule State are real pickers on this side.
    expect(within(panel).getAllByRole('combobox')).toHaveLength(3)
  })

  it('reads Release from the REFERENCE feed, for the Story’s own project, with an Unscheduled option', () => {
    renderModal()
    // `useReleaseOptions`, never `useReleaseRecords`: `GET /releases` needs `release:view`, which the
    // project Editor who owns this Story does not hold.
    expect(useReleaseOptions).toHaveBeenCalledWith('p-1')
    const release = within(continuedPanel()).getByLabelText('Release')
    expect(release).toHaveValue('rel-1')
    expect([...release.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Unscheduled',
      'Release 1',
      'Release 2',
    ])
  })

  it('names the current Release from the PREVIEW when the feed has not produced it', () => {
    // Otherwise the select falls back to its first option and renders a scheduled Story as
    // `Unscheduled` while the draft still holds the id — the defect SU-01's `findReleaseName` exists
    // to prevent, one layer up.
    useReleaseOptions.mockReturnValue(queryReady([]))
    renderModal()
    const release = within(continuedPanel()).getByLabelText('Release')
    expect(release).toHaveValue('rel-1')
    expect(within(release).getByText('Release 1')).toBeInTheDocument()
  })

  it('offers EXACTLY the preview’s targets, in the order given (BR-06/AC5)', () => {
    renderModal()
    const iteration = within(continuedPanel()).getByLabelText('Iteration')
    expect(iteration).toHaveValue('iter-3')
    expect([...iteration.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'iter-3',
      'iter-4',
    ])
    // The SOURCE iteration is not a target, and neither is anything else the server withheld.
    expect(within(iteration).queryByText('Sprint 26.1')).toBeNull()
  })

  it('handles a null target with no selection and no crash', () => {
    const noTarget = eligiblePreview()
    useSplitPreview.mockReturnValue(
      queryReady({
        ...noTarget,
        eligible: false,
        ineligibleReason: 'no_target',
        targets: [],
        defaults: { ...noTarget.defaults, targetIterationId: null },
      }),
    )
    renderModal()
    const iteration = within(continuedPanel()).getByLabelText('Iteration')
    expect(iteration).toHaveValue('')
    expect(confirmButton()).toBeDisabled()
  })

  it('offers all six schedule states from the shared constants', () => {
    renderModal()
    const state = within(continuedPanel()).getByLabelText('Schedule State')
    expect(state).toHaveValue('in_progress')
    expect([...state.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'idea',
      'defined',
      'in_progress',
      'completed',
      'accepted',
      'release',
    ])
  })

  it('accepts a target change, and only from the offered set', () => {
    renderModal()
    const iteration = within(continuedPanel()).getByLabelText('Iteration')
    fireEvent.change(iteration, { target: { value: 'iter-4' } })
    expect(iteration).toHaveValue('iter-4')
  })

  // ── 2.6 the invalid state, which has no words ───────────────────────────────

  it('marks a blanked title `aria-invalid`, and only that field', () => {
    renderModal()
    const title = within(unfinishedPanel()).getByLabelText('Title')
    fireEvent.change(title, { target: { value: '   ' } })
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(within(continuedPanel()).getByLabelText('Title')).not.toHaveAttribute('aria-invalid')
    expect(within(unfinishedPanel()).getByLabelText('Plan Estimate (pts)')).not.toHaveAttribute(
      'aria-invalid',
    )
  })

  it('removes `aria-invalid` again once the field is valid', () => {
    renderModal()
    const title = within(continuedPanel()).getByLabelText('Title')
    fireEvent.change(title, { target: { value: '' } })
    expect(title).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(title, { target: { value: 'Continued work' } })
    expect(title).not.toHaveAttribute('aria-invalid')
  })

  it('marks an estimate that is not a number ≥ 0, and leaves an EMPTY one alone', () => {
    renderModal()
    const estimate = within(continuedPanel()).getByLabelText('Plan Estimate (pts)')
    for (const invalid of ['-', '-2', 'abc']) {
      fireEvent.change(estimate, { target: { value: invalid } })
      expect(estimate, invalid).toHaveAttribute('aria-invalid', 'true')
    }
    // Empty is an UNPOINTED story — legal, and not the same as 0.
    for (const valid of ['', '0', '2.5']) {
      fireEvent.change(estimate, { target: { value: valid } })
      expect(estimate, valid).not.toHaveAttribute('aria-invalid')
    }
  })

  it('says NOTHING about an invalid field — no message, no hint, no toast, no alert (AC6, SRS §12)', () => {
    renderModal()
    fireEvent.change(within(unfinishedPanel()).getByLabelText('Title'), { target: { value: '' } })
    fireEvent.change(within(continuedPanel()).getByLabelText('Plan Estimate (pts)'), {
      target: { value: '-9' },
    })
    // The field is marked, so the state IS being rendered…
    expect(document.body.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2)
    // …and nothing anywhere says a word about it. `FormField`'s `error` prop renders
    // `role="alert"`, which is exactly why it is never passed. `role="status"` is checked by TEXT,
    // not by presence: `DndContext` (SU-03) renders an empty `aria-live` announcer for drag
    // accessibility, and an empty live region announces nothing — a toast would have words.
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(
      [...document.body.querySelectorAll('[role="status"]')]
        .map((n) => n.textContent ?? '')
        .join(''),
    ).toBe('')
    expect(screen.queryByText(/required/i)).toBeNull()
    expect(screen.queryByText(/invalid/i)).toBeNull()
    expect(screen.queryByText(/must be/i)).toBeNull()
    expect(screen.queryByText(/warning/i)).toBeNull()
  })

  it('never renders `ineligibleReason`, for any of its five values', () => {
    /**
     * The probe is CASE-SENSITIVE and reads `textContent`, and that is a change SU-02 forced.
     *
     * SU-01 asserted this with `queryByText(new RegExp(reason, 'i'))`, which worked while the panels
     * were empty. It cannot survive SU-02: `unscheduled` is both an ineligibility reason AND the
     * product's own word for "no release", which the `[Unfinished]` panel now renders twice. So an
     * `/unscheduled/i` probe matches legitimate copy and the assertion stops being about the field.
     * The reasons are raw snake_case wire values — `not_a_story`, `no_target` — so the honest claim is
     * that the RAW value never reaches the screen, which case-sensitive containment states exactly.
     */
    for (const reason of [
      'not_a_story',
      'finished_state',
      'unscheduled',
      'no_target',
      'not_editable',
    ]) {
      useSplitPreview.mockReturnValue(
        queryReady({ ...eligiblePreview(), eligible: false, ineligibleReason: reason }),
      )
      const view = render(
        <SplitStoryModal
          open
          onClose={vi.fn()}
          workItemId="wi-1"
          itemKey="US-1"
          title="Upgrade NX workspace to v21"
        />,
      )
      expect(document.body.textContent, reason).not.toContain(reason)
      view.unmount()
    }
  })

  it('keeps `Split story` DISABLED throughout — valid, invalid and back (§8 Q14)', () => {
    // `canConfirm` is computed on the derived draft and deliberately NOT wired here: the write path
    // lands whole in SU-06, which enables the button and removes the tooltip together.
    renderModal()
    expect(confirmButton()).toBeDisabled()
    const title = within(continuedPanel()).getByLabelText('Title')
    fireEvent.change(title, { target: { value: '' } })
    expect(confirmButton()).toBeDisabled()
    fireEvent.change(title, { target: { value: 'Continued work' } })
    expect(confirmButton()).toBeDisabled()
    expect(confirmButton()).toHaveAttribute('title', 'Saving a split is not available yet')
  })
})
