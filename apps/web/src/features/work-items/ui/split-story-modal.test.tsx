/**
 * SplitStoryModal — the shell, the footer summary and the write.
 *
 * Half of these tests assert an ABSENCE, and that is deliberate. SRS §11 forbids an explanation beside
 * an unavailable Split control, and the plan's §7 names absence as "the part of this feature most
 * likely to regress, because adding a helpful message feels like an improvement". A test that only
 * checks what IS rendered would pass after somebody helpfully added the reason.
 *
 * The confirm button is asserted to follow the DRAFT — enabled when `canConfirm` is true, disabled
 * while a write is in flight — rather than to hold any fixed state. Field-level behaviour lives in
 * `split-story-panel.test.tsx`, the collections in `split-collection.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { useSplitPreview, useReleaseOptions, useSplitWorkItem, navigate } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  useReleaseOptions: vi.fn(),
  useSplitWorkItem: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview, useSplitWorkItem }))
/**
 * The `[Continued]` panel reads the release REFERENCE feed, so this file has to mock it: an unmocked
 * `useQuery` in a test with no `QueryClientProvider` throws, and it would take every test in the file
 * with it.
 */
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))
/**
 * The modal navigates to `[Continued]` on success (SU-07 AC1's landing), and `useNavigate` outside a
 * router throws. Mocking it also makes the destination ASSERTABLE, which is
 * the part worth testing — the router itself is not this file's subject.
 */
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import '@/shared/i18n/i18n'
import { setFormatPrefs } from '@/shared/lib/format-prefs'
import type { SplitSide } from '@/features/work-items/api'
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

/** The 201 body: the Event and BOTH Stories (SU-06). */
function splitResult() {
  return {
    split: { id: 'split-1', continuedStoryId: 'wi-1', unfinishedStoryId: 'wi-9' },
    unfinished: { id: 'wi-9', itemKey: 'US-7' },
    continued: { id: 'wi-1', itemKey: 'US-1' },
  }
}

/** Rebuilt per test in `beforeEach`, so `mutateAsync` calls never leak between assertions. */
let splitMutation: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }

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
    // `format-prefs` is a module SINGLETON, so the `de` test below would otherwise leak its locale
    // into every test declared after it. Reset rather than restore-in-afterEach: a failing test that
    // throws before its cleanup would leak just the same.
    setFormatPrefs({ locale: 'en', timeZone: 'UTC' })
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
    // SU-06: the write. `mutateAsync` resolves with the 201 body, so the modal's navigation target
    // comes from the RESPONSE rather than from what the test happens to know.
    splitMutation = { mutateAsync: vi.fn(async () => splitResult()), isPending: false }
    useSplitWorkItem.mockReset()
    useSplitWorkItem.mockImplementation(() => splitMutation)
    navigate.mockReset()
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

  it('renders `Split story` ENABLED on a valid draft', () => {
    // And with NO `title`: a button that works does not have to explain itself, so the tooltip's
    // absence is part of the claim rather than an incidental detail.
    renderModal()
    const confirm = screen.getByRole('button', { name: 'Split story' })
    expect(confirm).toBeEnabled()
    expect(confirm).not.toHaveAttribute('title')
  })

  it('keeps `Split story` disabled while the draft is invalid, and re-enables it (AC6)', () => {
    renderModal()
    const title = screen.getByLabelText('Title', { selector: '#split-continued-title' })
    fireEvent.change(title, { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Split story' })).toBeDisabled()
    fireEvent.change(title, { target: { value: 'Continued work' } })
    expect(screen.getByRole('button', { name: 'Split story' })).toBeEnabled()
  })

  it('is disabled when the SERVER said the Story is not splittable, whatever the draft says', () => {
    // `canConfirm` folds in `eligible`, so this cannot be bypassed by editing the fields.
    useSplitPreview.mockReturnValue(queryReady({ ...eligiblePreview(), eligible: false }))
    renderModal()
    expect(screen.getByRole('button', { name: 'Split story' })).toBeDisabled()
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

  const estimateField = (side: SplitSide) =>
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

  // ── Review follow-up (2026-09-17): every footer number through `Intl` ────────
  //
  // The footer's four numbers now go through `formatPoints`/`formatNumber`, which resolve the locale
  // from `getFormatPrefs()` — per-user, then per-workspace (`resolveFormatPrefs`). The i18n layer does
  // NOT compensate: the strings interpolate a bare `{{original}}`, and `i18n.ts` sets no format
  // function. So without the helpers these values render through default JS stringification, which
  // diverges from every other numeric surface in the app on both the group separator and the decimal
  // mark. These two tests fail on the pre-review code (`1234.5h`, `Points: 1500 → 3000 (+1500)`).

  /** Values big enough for a group separator, and fractional enough for a decimal mark. */
  function previewWithBigNumbers() {
    const base = eligiblePreview()
    return {
      ...base,
      story: { ...base.story, planEstimate: 1500 },
      tasks: [
        {
          id: 'ta-9',
          itemKey: 'TA-9',
          title: 'A long-running task',
          state: 'in_progress',
          todoHours: 2000,
          estimateHours: 3000,
          actualHours: 1234.5,
          defaultSide: 'continued',
        },
      ],
    }
  }

  it('formats every footer number with the reader locale (en)', () => {
    useSplitPreview.mockReturnValue(queryReady(previewWithBigNumbers()))
    renderModal()
    expect(screen.getByText('1,234.5h Actual · 2,000h To Do')).toBeInTheDocument()
    // Both sides default to the original 1500 (BR-12), so an untouched draft reads +1,500.
    expect(screen.getByText('Points: 1,500 → 3,000 (+1,500)')).toBeInTheDocument()
  })

  it('follows the locale to a comma decimal mark and a dot group separator (de)', () => {
    setFormatPrefs({ locale: 'de' })
    useSplitPreview.mockReturnValue(queryReady(previewWithBigNumbers()))
    renderModal()
    expect(screen.getByText('1.234,5h Actual · 2.000h To Do')).toBeInTheDocument()
    expect(screen.getByText('Points: 1.500 → 3.000 (+1.500)')).toBeInTheDocument()
  })

  it('signs a NEGATIVE delta once, and lets the formatter own the digits', () => {
    // `formatDelta` adds `+` only when positive: a negative number already carries its own sign, and
    // `+-3` is the bug this pins.
    renderModal()
    fireEvent.change(estimateField('unfinished'), { target: { value: '1' } })
    fireEvent.change(estimateField('continued'), { target: { value: '1' } })
    expect(screen.getByText('Points: 5 → 2 (-3)')).toHaveClass('text-warning')
  })

  // ── SU-06: the write ────────────────────────────────────────────────────────

  it('submits the `[Unfinished]` side ONLY, with the source Iteration it rendered (D9)', async () => {
    useSplitPreview.mockReturnValue(queryReady(previewWithChildren()))
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Split story' }))
    await waitFor(() => expect(splitMutation.mutateAsync).toHaveBeenCalledTimes(1))
    expect(splitMutation.mutateAsync).toHaveBeenCalledWith({
      // The ECHO, not a re-read: this is what makes a Story that moved since the modal opened a 412
      // rather than a silent split into the wrong sprint.
      expectedSourceIterationId: 'iter-1',
      targetIterationId: 'iter-3',
      unfinished: { title: '[Unfinished] Upgrade NX workspace to v21', planEstimate: 5 },
      continued: {
        title: '[Continued] Upgrade NX workspace to v21',
        planEstimate: 5,
        releaseId: 'rel-1',
        scheduleState: 'in_progress',
      },
      // BR-14 — only the Completed Task defaults left; the body names no `continued*` array at all,
      // because the server derives that side from the Story's live children.
      unfinishedTaskIds: ['ta-1'],
      unfinishedDefectIds: [],
      unfinishedTestCaseIds: [],
    })
  })

  it('sends the estimates as NULL when a field is empty — an unpointed Story is not 0', async () => {
    renderModal()
    fireEvent.change(estimateField('unfinished'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split story' }))
    await waitFor(() => expect(splitMutation.mutateAsync).toHaveBeenCalled())
    const body = splitMutation.mutateAsync.mock.calls[0][0] as {
      unfinished: { planEstimate: number | null }
    }
    expect(body.unfinished.planEstimate).toBeNull()
  })

  it('trims the titles it sends, without trimming what the reader sees', async () => {
    renderModal()
    const title = screen.getByLabelText('Title', { selector: '#split-unfinished-title' })
    fireEvent.change(title, { target: { value: '  Historical record  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split story' }))
    await waitFor(() => expect(splitMutation.mutateAsync).toHaveBeenCalled())
    const body = splitMutation.mutateAsync.mock.calls[0][0] as { unfinished: { title: string } }
    expect(body.unfinished.title).toBe('Historical record')
    // The field itself still holds what was typed — trimming under the cursor is its own defect.
    expect(title).toHaveValue('  Historical record  ')
  })

  it('closes and lands on `[Continued]` (SU-07 AC1) using the RESPONSE’s key', async () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Split story' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(navigate).toHaveBeenCalledWith({ to: '/item/$itemKey', params: { itemKey: 'US-1' } })
  })

  it('keeps the modal OPEN and states the server’s refusal when the split fails (BR-32)', async () => {
    // The reader must be able to retry or cancel, and the message has to be the server's: "this story
    // has moved to a different iteration" is actionable, "split failed" is not.
    splitMutation.mutateAsync = vi.fn(async () => {
      throw new Error('This story has moved to a different iteration since the split was opened')
    })
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Split story' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This story has moved to a different iteration since the split was opened',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    // Still a dialog, still editable — a failed write is not a closed modal.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('says nothing at all until a write actually fails', () => {
    renderModal()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables both controls while the split is in flight, and says which is happening', () => {
    splitMutation.isPending = true
    renderModal()
    expect(screen.getByRole('button', { name: 'Splitting…' })).toBeDisabled()
    // Cancel too: a Split is one transaction, and closing the modal mid-write would leave the reader
    // believing they stopped it.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})
