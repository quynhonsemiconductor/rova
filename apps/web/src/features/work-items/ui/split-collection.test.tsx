/**
 * SplitCollection — the three distributions (SU-03 / SU-04 / SU-05).
 *
 * Rendered THROUGH `SplitStoryModal`, for the same reason the panel spec is: the claim worth making
 * is that clicking a row's arrow reaches the reducer and the row LEAVES one side and APPEARS on the
 * other. A collection mounted alone with a hand-built row list would assert only that a callback
 * fires.
 *
 * Absences are queried on `document.body` — `AppModal` renders through a Radix Portal, so a
 * container-scoped query passes vacuously.
 *
 * What is deliberately NOT tested here: effort preservation (AC3) and the Task roll-ups (AC4). Both
 * are backend behaviour, satisfied by construction (D3/D4), and there is no write path until SU-06 —
 * PR 6's e2e asserts them against stored columns. Asserting them from the browser now would be
 * asserting a draft, not a fact.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const { useSplitPreview, useReleaseOptions, useSplitWorkItem, navigate } = vi.hoisted(() => ({
  useSplitPreview: vi.fn(),
  useReleaseOptions: vi.fn(),
  // SU-06 — never resolves: this file distributes items, it does not confirm.
  useSplitWorkItem: vi.fn(() => ({
    mutateAsync: vi.fn(() => new Promise(() => {})),
    isPending: false,
  })),
  navigate: vi.fn(),
}))

vi.mock('@/features/work-items/api', () => ({ useSplitPreview, useSplitWorkItem }))
vi.mock('@/features/releases/api', () => ({ useReleaseOptions }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import '@/shared/i18n/i18n'
import { setFormatPrefs } from '@/shared/lib/format-prefs'
import { SplitStoryModal } from './split-story-modal'

/** The seeded NXP shape: TA-1 completed (defaults left), everything else right. */
function preview() {
  return {
    eligible: true,
    ineligibleReason: null,
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
      {
        id: 'ta-3',
        itemKey: 'TA-3',
        title: 'Update the docs',
        state: 'defined',
        todoHours: null,
        estimateHours: null,
        actualHours: null,
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
        explicitIterationId: 'iter-1',
        explicitIterationName: 'Sprint 26.1',
        defaultSide: 'continued',
      },
      {
        id: 'de-2',
        itemKey: 'DE-2',
        title: 'Flaky snapshot',
        scheduleState: 'in_progress',
        priority: 'normal',
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
      {
        id: 'tc-2',
        testCaseKey: 'TC-2',
        name: 'Watch mode survives a rename',
        type: 'Regression',
        lastVerdict: null,
        defaultSide: 'continued',
      },
    ],
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

const unfinishedPanel = () => screen.getByRole('region', { name: /\[Unfinished\]/ })
const continuedPanel = () => screen.getByRole('region', { name: /\[Continued\]/ })
/** Each collection's `<ul>` takes its name from its own heading. */
const list = (panel: HTMLElement, name: string) => within(panel).getByRole('list', { name })
const confirmButton = () => screen.getByRole('button', { name: 'Split story' })

/**
 * "No toast" cannot be `querySelector('[role="status"]') === null` any more: `DndContext` renders its
 * own `aria-live` announcer with `role="status"`, which is drag ACCESSIBILITY, not a message. The
 * claim is that nothing is ANNOUNCED — an empty live region says nothing, a toast has text.
 */
function announcedText(): string {
  return [...document.body.querySelectorAll('[role="status"]')]
    .map((node) => node.textContent ?? '')
    .join('')
}

describe('SplitCollection', () => {
  beforeEach(() => {
    // `format-prefs` is a module singleton; the `de` case below would otherwise leak its locale into
    // every test declared after it.
    setFormatPrefs({ locale: 'en', timeZone: 'UTC' })
    useSplitPreview.mockReset()
    useSplitPreview.mockReturnValue(queryReady(preview()))
    useReleaseOptions.mockReset()
    useReleaseOptions.mockReturnValue(queryReady([]))
  })

  // ── SU-03: Tasks ────────────────────────────────────────────────────────────

  it('seats every child on the side the SERVER chose (BR-14/15), never on one the browser derived', () => {
    renderModal()
    // BR-14: the Completed Task defaults to `[Unfinished]`, every other Task to `[Continued]`.
    expect(within(list(unfinishedPanel(), 'Tasks')).getByText('TA-1')).toBeInTheDocument()
    expect(within(list(continuedPanel(), 'Tasks')).getByText('TA-2')).toBeInTheDocument()
    expect(within(list(continuedPanel(), 'Tasks')).getByText('TA-3')).toBeInTheDocument()
    expect(within(list(unfinishedPanel(), 'Tasks')).queryByText('TA-2')).toBeNull()
    // BR-15: Defects and Test Cases default right, so the left lists are empty.
    expect(within(list(continuedPanel(), 'Defects')).getByText('DE-1')).toBeInTheDocument()
    expect(within(list(continuedPanel(), 'Test Cases')).getByText('TC-1')).toBeInTheDocument()
    expect(within(list(unfinishedPanel(), 'Defects')).queryByText('DE-1')).toBeNull()
  })

  it('shows a Task’s state and To Do, and `--` for an unset To Do — never 0h', () => {
    renderModal()
    const tasks = list(continuedPanel(), 'Tasks')
    expect(within(tasks).getByText('3h To Do')).toBeInTheDocument()
    // TA-3 has `todoHours: null`. `0h` would be a measurement the server never made.
    expect(within(tasks).getByText('--')).toBeInTheDocument()
    expect(within(tasks).getByText('In-Progress')).toBeInTheDocument()
    // TA-1's `0` IS a measurement, and reads as such on the other side.
    expect(within(list(unfinishedPanel(), 'Tasks')).getByText('0h To Do')).toBeInTheDocument()
  })

  // ── Review follow-up (2026-09-17): a row and the footer are the same quantity ─
  //
  // The footer's To Do total is the SUM of these rows, so the two must be formatted by the same
  // helper or one modal shows one quantity two ways. Both of these fail on the pre-review code, which
  // interpolated `task.todoHours` raw: `1234.5h To Do` beside a footer reading `1,234.5h To Do`.

  /** One Task carrying enough hours for a group separator and a fractional part. */
  function previewWithBigHours() {
    const base = preview()
    return {
      ...base,
      tasks: [{ ...base.tasks[1], id: 'ta-9', itemKey: 'TA-9', todoHours: 1234.5, actualHours: 0 }],
    }
  }

  it('formats a row’s To Do exactly as the footer that sums it (en)', () => {
    useSplitPreview.mockReturnValue(queryReady(previewWithBigHours()))
    renderModal()
    expect(within(list(continuedPanel(), 'Tasks')).getByText('1,234.5h To Do')).toBeInTheDocument()
    expect(screen.getByText('0h Actual · 1,234.5h To Do')).toBeInTheDocument()
  })

  it('follows the reader’s locale on the row, not only in the footer (de)', () => {
    setFormatPrefs({ locale: 'de' })
    useSplitPreview.mockReturnValue(queryReady(previewWithBigHours()))
    renderModal()
    expect(within(list(continuedPanel(), 'Tasks')).getByText('1.234,5h To Do')).toBeInTheDocument()
    expect(screen.getByText('0h Actual · 1.234,5h To Do')).toBeInTheDocument()
  })

  it('moves a row to the other side, and it LEAVES the one it came from (AC1/AC2)', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' }))
    expect(within(list(continuedPanel(), 'Tasks')).getByText('TA-1')).toBeInTheDocument()
    expect(within(list(unfinishedPanel(), 'Tasks')).queryByText('TA-1')).toBeNull()
  })

  it('moves it back, and it lands in the preview’s order rather than at the end', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-2 to [Unfinished]' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-2 to [Continued]' }))
    const keys = within(list(continuedPanel(), 'Tasks'))
      .getAllByText(/^TA-\d$/)
      .map((node) => node.textContent)
    expect(keys).toEqual(['TA-2', 'TA-3'])
  })

  it('labels every arrow with the item AND its destination (accessibility)', () => {
    renderModal()
    // The label is the whole keyboard affordance: `Move TA-1 to [Continued]` says which row and
    // where, so a screen-reader user never has to infer the direction from the panel they are in.
    expect(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move TA-2 to [Unfinished]' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move DE-1 to [Unfinished]' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move TC-1 to [Unfinished]' })).toBeInTheDocument()
  })

  it('does NOT advertise a keyboard drag it cannot perform', () => {
    // `useDraggable().attributes` would add `role="button"`, `tabIndex=0` and
    // `aria-roledescription="draggable"` to every row — a promise that Space starts a cross-panel
    // drag, which `sortableKeyboardCoordinates` does not implement. The arrow BUTTON is the keyboard
    // path; the row is pointer-only. If a later PR spreads `attributes`, it must also make keyboard
    // dropping real, and this test is what says so.
    renderModal()
    expect(document.body.querySelector('[aria-roledescription="draggable"]')).toBeNull()
    expect(document.body.querySelector('li[tabindex]')).toBeNull()
  })

  it('counts each side separately, and the count follows a move', () => {
    renderModal()
    const tasksPill = (panel: HTMLElement) =>
      within(panel).getByRole('list', { name: 'Tasks' }).previousElementSibling?.textContent
    expect(tasksPill(unfinishedPanel())).toBe('Tasks1')
    expect(tasksPill(continuedPanel())).toBe('Tasks2')
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' }))
    expect(tasksPill(unfinishedPanel())).toBe('Tasks0')
    expect(tasksPill(continuedPanel())).toBe('Tasks3')
  })

  // ── SU-03 AC5: an empty side ─────────────────────────────────────────────────

  it('renders the drop state on an empty side and blocks nothing (AC5)', () => {
    renderModal()
    // The copy names BOTH paths — "use the arrow buttons or drag here" — deliberately (review
    // follow-up): the arrow button is the primary and the only KEYBOARD path, so an empty state that
    // said only "Drop items here" told a screen-reader user to do the one thing they cannot. It is
    // still not a validation message: an empty side is a legal split.
    const emptyCopy = 'No items — use the arrow buttons or drag here'
    // The `[Unfinished]` Defects and Test Cases lists start empty (BR-15).
    expect(within(list(unfinishedPanel(), 'Defects')).getByText(emptyCopy)).toBeInTheDocument()
    expect(within(list(unfinishedPanel(), 'Test Cases')).getByText(emptyCopy)).toBeInTheDocument()
    // Emptying the Tasks side too — still no message, still no alert.
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' }))
    expect(within(list(unfinishedPanel(), 'Tasks')).getByText(emptyCopy)).toBeInTheDocument()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.querySelector('[aria-invalid="true"]')).toBeNull()
  })

  // ── SU-04: Defects ──────────────────────────────────────────────────────────

  it('states a Defect’s own Iteration inline, and only when it has one (BR-18/AC4)', () => {
    renderModal()
    const defects = list(continuedPanel(), 'Defects')
    expect(within(defects).getByText('Explicit: Sprint 26.1')).toBeInTheDocument()
    // DE-2 has none — §8 Q8 ruled that a no-op, so there is nothing to say about it.
    expect(within(defects).queryAllByText(/^Explicit:/)).toHaveLength(1)
    expect(within(defects).getByText('High')).toBeInTheDocument()
  })

  it('says nothing more about the explicit Iteration — no warning sentence, and it blocks nothing', () => {
    renderModal()
    expect(screen.queryByText(/warning/i)).toBeNull()
    expect(screen.queryByText(/will be/i)).toBeNull()
    expect(screen.queryByText(/unchanged/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Move DE-1 to [Unfinished]' }))
    // It moved, and the line moved with it — the Iteration itself is untouched by a Split (BR-18),
    // which is a BACKEND claim asserted in PR 6's e2e, not here.
    expect(
      within(list(unfinishedPanel(), 'Defects')).getByText('Explicit: Sprint 26.1'),
    ).toBeInTheDocument()
  })

  // ── SU-05: Test Cases ───────────────────────────────────────────────────────

  it('renders a Test Case by `testCaseKey` + `name`, with its Type and Verdict', () => {
    renderModal()
    const cases = list(continuedPanel(), 'Test Cases')
    expect(within(cases).getByText('TC-1')).toBeInTheDocument()
    expect(within(cases).getByText('Build succeeds on a clean checkout')).toBeInTheDocument()
    expect(within(cases).getByText('Functional')).toBeInTheDocument()
    expect(within(cases).getByText('Pass')).toBeInTheDocument()
  })

  it('renders a null verdict as `Not Run` — never `--`, never blank (BR10)', () => {
    renderModal()
    expect(within(list(continuedPanel(), 'Test Cases')).getByText('Not Run')).toBeInTheDocument()
  })

  it('renders every verdict the style map knows, and falls back to `Not Run` for one it does not', () => {
    // `lastVerdict` is typed `string | null` on the wire, so an unknown value must render, not crash
    // the modal by indexing the style map with a missing key.
    const verdicts = [
      'pass',
      'fail',
      'blocked',
      'error',
      'inconclusive',
      'not_run',
      'something-new',
    ]
    useSplitPreview.mockReturnValue(
      queryReady({
        ...preview(),
        testCases: verdicts.map((verdict, index) => ({
          id: `tc-${index}`,
          testCaseKey: `TC-${index}`,
          name: `Case ${index}`,
          type: 'Functional',
          lastVerdict: verdict === 'not_run' ? null : verdict,
          defaultSide: 'continued',
        })),
      }),
    )
    renderModal()
    const cases = list(continuedPanel(), 'Test Cases')
    for (const label of ['Pass', 'Fail', 'Blocked', 'Error', 'Inconclusive']) {
      expect(within(cases).getByText(label), label).toBeInTheDocument()
    }
    // The explicit null AND the unknown string both read `Not Run`.
    expect(within(cases).getAllByText('Not Run')).toHaveLength(2)
  })

  it('moves a Test Case, and Tasks/Defects stay where they were', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Move TC-2 to [Unfinished]' }))
    expect(within(list(unfinishedPanel(), 'Test Cases')).getByText('TC-2')).toBeInTheDocument()
    expect(within(list(continuedPanel(), 'Test Cases')).getByText('TC-1')).toBeInTheDocument()
    expect(within(list(continuedPanel(), 'Defects')).getByText('DE-1')).toBeInTheDocument()
    expect(within(list(unfinishedPanel(), 'Tasks')).getByText('TA-1')).toBeInTheDocument()
  })

  // ── Distribution never blocks the write ─────────────────────────────────────

  it('keeps `Split story` available through every move (AC5 — any distribution is legal)', () => {
    // SU-02/03 asserted "disabled throughout" because there was no write path. Now that there is, the
    // claim that matters is the opposite one: moving items — including emptying a side entirely — never
    // makes the split unsavable, and says nothing (`announcedText` covers the toast absence, since
    // `DndContext` renders an empty live region of its own).
    renderModal()
    expect(confirmButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move DE-1 to [Unfinished]' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move TC-1 to [Unfinished]' }))
    expect(confirmButton()).toBeEnabled()
    expect(announcedText()).toBe('')
  })

  it('leaves the footer totals alone — they count the STORY, not one side', () => {
    // The count pills answer "what is on this side"; the footer answers "what does this split
    // carry". A move changes the first and must not change the second.
    renderModal()
    expect(screen.getByText('3 Tasks · 2 Defects · 2 Test Cases')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Move TA-1 to [Continued]' }))
    expect(screen.getByText('3 Tasks · 2 Defects · 2 Test Cases')).toBeInTheDocument()
  })
})
