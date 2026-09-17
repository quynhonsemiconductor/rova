/**
 * `model/split-draft.ts` — the draft reducer, tested WITHOUT A DOM.
 *
 * That is the point of the module existing: validation, the point comparison and the target
 * restriction are arithmetic and rules, so they are provable without rendering anything, and a
 * failure here names the rule rather than the widget.
 *
 * Two claims are asserted BY ASSERTING THE PREVIEW'S OWN VALUE rather than by re-running a rule:
 *   • prefixes never stack (§8 Q10) — the server strips them, so the draft must simply carry
 *     `defaults.unfinishedTitle` through. Re-implementing `stripSplitPrefix` here to check it would
 *     be the second copy §8 Q17 forbids, and would pass even if the component ignored `defaults`.
 *   • the default distribution (BR-14/15) comes from `defaultSide`, never from a Task's state.
 */
import { describe, expect, it } from 'vitest'

import type { SplitPreview } from '@/features/work-items/api'
import {
  deriveSplitDraft,
  initSplitDraft,
  parsePlanEstimate,
  rowsOnSide,
  splitDraftReducer,
  splitPreviewTotals,
  unfinishedIdsFor,
  type SplitDraft,
} from './split-draft'

/** The seeded NXP shape: `US-1` in Sprint 26.1, one later target, three Tasks, one of them done. */
const BASE: SplitPreview = {
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
      state: 'in_progress',
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

function preview(over: Partial<SplitPreview> = {}): SplitPreview {
  return { ...BASE, ...over }
}

/** A draft with one estimate field replaced, for the parsing cases. */
function withEstimates(unfinished: string, continued: string): SplitDraft {
  const draft = initSplitDraft(preview())
  return {
    ...draft,
    unfinished: { ...draft.unfinished, planEstimateText: unfinished },
    continued: { ...draft.continued, planEstimateText: continued },
  }
}

describe('initSplitDraft — every default comes from the preview', () => {
  it('seeds both titles from `defaults`, not from the Story title', () => {
    const draft = initSplitDraft(preview())
    expect(draft.unfinished.title).toBe('[Unfinished] Upgrade NX workspace to v21')
    expect(draft.continued.title).toBe('[Continued] Upgrade NX workspace to v21')
  })

  it('seeds the target from `defaults.targetIterationId` (BR-06, the earliest valid target)', () => {
    expect(initSplitDraft(preview()).targetIterationId).toBe('iter-3')
  })

  it('seeds BOTH estimates from the original (BR-12), as TEXT', () => {
    const draft = initSplitDraft(preview())
    expect(draft.unfinished.planEstimateText).toBe('5')
    expect(draft.continued.planEstimateText).toBe('5')
    expect(draft.originalPlanEstimate).toBe(5)
  })

  it("keeps `[Continued]`'s Release and Schedule State (BR-11 — unless edited)", () => {
    const draft = initSplitDraft(preview())
    expect(draft.continued.releaseId).toBe('rel-1')
    expect(draft.continued.scheduleState).toBe('in_progress')
  })

  it('carries `eligible` as the SERVER decided it, and never re-derives it', () => {
    expect(initSplitDraft(preview()).eligible).toBe(true)
    expect(initSplitDraft(preview({ eligible: false })).eligible).toBe(false)
  })

  it('seeds the three distributions from `defaultSide` (BR-14/15)', () => {
    const draft = initSplitDraft(preview())
    // The Completed Task, and only it, defaults to `[Unfinished]`.
    expect([...draft.unfinishedTaskIds]).toEqual(['ta-1'])
    // Defects and Test Cases default to `[Continued]`, so the `[Unfinished]` sets are empty.
    expect([...draft.unfinishedDefectIds]).toEqual([])
    expect([...draft.unfinishedTestCaseIds]).toEqual([])
  })

  it('trusts `defaultSide` even when it disagrees with the Task state (the rule is the server’s)', () => {
    // A server that decided differently must win: BR-14 is one rule, in one place, and the browser
    // re-deriving it from `state === 'completed'` is how the two come to disagree.
    const flipped = preview({
      tasks: BASE.tasks.map((task) => ({
        ...task,
        defaultSide: task.state === 'completed' ? ('continued' as const) : ('unfinished' as const),
      })),
    })
    expect([...initSplitDraft(flipped).unfinishedTaskIds]).toEqual(['ta-2', 'ta-3'])
  })

  it('holds the offered targets in the ORDER GIVEN (earliest first — BR-06/AC5)', () => {
    expect(initSplitDraft(preview()).allowedTargetIds).toEqual(['iter-3', 'iter-4'])
  })

  it('an unpointed Story stays null — null is NOT 0', () => {
    const draft = initSplitDraft(preview({ story: { ...BASE.story, planEstimate: null } }))
    expect(draft.originalPlanEstimate).toBeNull()
    expect(draft.unfinished.planEstimateText).toBe('')
    expect(draft.continued.planEstimateText).toBe('')
    // The parsed value round-trips as null, while the arithmetic still treats it as zero.
    const derived = deriveSplitDraft(draft)
    expect(derived.unfinished.planEstimate).toBeNull()
    expect(derived.originalPoints).toBe(0)
    expect(derived.combinedPoints).toBe(0)
    expect(derived.delta).toBe(0)
  })

  it('a re-split does NOT stack prefixes — the preview’s already-stripped value round-trips', () => {
    // The Story here is ALREADY a `[Continued]` one. The server stripped the prefix before applying
    // the new one (§8 Q10), so the draft must carry exactly what `defaults` says — and must not
    // produce `[Unfinished] [Continued] …`.
    const resplit = preview({
      story: { ...BASE.story, title: '[Continued] Upgrade NX workspace to v21' },
      defaults: {
        unfinishedTitle: '[Unfinished] Upgrade NX workspace to v21',
        continuedTitle: '[Continued] Upgrade NX workspace to v21',
        targetIterationId: 'iter-3',
      },
    })
    const draft = initSplitDraft(resplit)
    expect(draft.unfinished.title).toBe('[Unfinished] Upgrade NX workspace to v21')
    expect(draft.unfinished.title).not.toContain('[Continued]')
    expect(draft.continued.title).toBe('[Continued] Upgrade NX workspace to v21')
    expect(draft.continued.title).not.toContain('[Continued] [Continued]')
  })

  it('survives a null target list and a null default target — "no selection", not a crash', () => {
    // `no_target` is a real, server-reported outcome; and a payload that omits a collection must
    // read as "none" rather than throw inside a modal that has already opened.
    const empty = {
      ...BASE,
      targets: undefined,
      tasks: undefined,
      defects: undefined,
      testCases: undefined,
      eligible: false,
      ineligibleReason: 'no_target',
      defaults: { ...BASE.defaults, targetIterationId: null },
    } as unknown as SplitPreview
    const draft = initSplitDraft(empty)
    expect(draft.targetIterationId).toBeNull()
    expect(draft.allowedTargetIds).toEqual([])
    expect(draft.unfinishedTaskIds.size).toBe(0)
    expect(deriveSplitDraft(draft).canConfirm).toBe(false)
  })
})

describe('parsePlanEstimate — text in, a number OR null OR invalid out', () => {
  it('an empty field is legal and parses to null, never 0', () => {
    expect(parsePlanEstimate('')).toEqual({ value: null, invalid: false })
    expect(parsePlanEstimate('   ')).toEqual({ value: null, invalid: false })
  })

  it('accepts 0 and decimals', () => {
    expect(parsePlanEstimate('0')).toEqual({ value: 0, invalid: false })
    expect(parsePlanEstimate('2.5')).toEqual({ value: 2.5, invalid: false })
    expect(parsePlanEstimate(' 8 ')).toEqual({ value: 8, invalid: false })
  })

  it('refuses a negative number', () => {
    expect(parsePlanEstimate('-1')).toEqual({ value: null, invalid: true })
  })

  it('refuses non-numeric text, including a half-typed `-` or `.`', () => {
    // The reason the field is held as TEXT: `Number('-')` is NaN, and a `type="number"` input would
    // have reported this keystroke as an EMPTY field — which is a legal, different value.
    for (const text of ['-', '.', 'abc', '1,5', 'Infinity']) {
      expect(parsePlanEstimate(text), text).toEqual({ value: null, invalid: true })
    }
  })
})

describe('splitDraftReducer', () => {
  it('`reset` is the only action that can create a draft', () => {
    expect(splitDraftReducer(null, { type: 'title', side: 'unfinished', value: 'x' })).toBeNull()
    expect(splitDraftReducer(null, { type: 'reset', preview: preview() })).not.toBeNull()
  })

  it('edits one side without touching the other', () => {
    const draft = initSplitDraft(preview())
    const next = splitDraftReducer(draft, { type: 'title', side: 'continued', value: 'Only mine' })
    expect(next?.continued.title).toBe('Only mine')
    expect(next?.unfinished.title).toBe(draft.unfinished.title)
  })

  it('keeps the estimate as typed, character by character', () => {
    const draft = initSplitDraft(preview())
    const next = splitDraftReducer(draft, {
      type: 'planEstimate',
      side: 'unfinished',
      value: '-',
    })
    expect(next?.unfinished.planEstimateText).toBe('-')
  })

  it('sets Release and Schedule State on the `[Continued]` side', () => {
    const draft = initSplitDraft(preview())
    expect(splitDraftReducer(draft, { type: 'releaseId', value: null })?.continued.releaseId).toBe(
      null,
    )
    expect(
      splitDraftReducer(draft, { type: 'scheduleState', value: 'defined' })?.continued
        .scheduleState,
    ).toBe('defined')
  })

  it('accepts a target FROM the offered set', () => {
    const draft = initSplitDraft(preview())
    expect(
      splitDraftReducer(draft, { type: 'targetIteration', value: 'iter-4' })?.targetIterationId,
    ).toBe('iter-4')
  })

  it('IGNORES a target outside the offered set — the draft cannot name what the write refuses', () => {
    // A picker wider than the write is the fault class the plan's risk register names. The reducer
    // is the last place that can still refuse, so it does — silently, since the UI never offers it.
    const draft = initSplitDraft(preview())
    for (const value of ['iter-1', 'iter-99', '']) {
      expect(
        splitDraftReducer(draft, { type: 'targetIteration', value })?.targetIterationId,
        value,
      ).toBe('iter-3')
    }
  })
})

describe('deriveSplitDraft — validation (AC6) and the point comparison (BR-13)', () => {
  it('a blank or whitespace-only title is invalid, per side', () => {
    const draft = initSplitDraft(preview())
    const blankLeft = { ...draft, unfinished: { ...draft.unfinished, title: '' } }
    const spacesRight = { ...draft, continued: { ...draft.continued, title: '   ' } }
    expect(deriveSplitDraft(blankLeft).unfinished.titleInvalid).toBe(true)
    expect(deriveSplitDraft(blankLeft).continued.titleInvalid).toBe(false)
    expect(deriveSplitDraft(spacesRight).continued.titleInvalid).toBe(true)
    expect(deriveSplitDraft(spacesRight).unfinished.titleInvalid).toBe(false)
    // The aggregate is what a shell surface would read.
    expect(deriveSplitDraft(blankLeft).titleInvalid).toBe(true)
    expect(deriveSplitDraft(draft).titleInvalid).toBe(false)
  })

  it('marks only the offending estimate field', () => {
    const derived = deriveSplitDraft(withEstimates('-2', '3'))
    expect(derived.unfinished.estimateInvalid).toBe(true)
    expect(derived.continued.estimateInvalid).toBe(false)
    expect(derived.estimateInvalid).toBe(true)
  })

  it('an empty estimate is valid on both sides', () => {
    const derived = deriveSplitDraft(withEstimates('', ''))
    expect(derived.estimateInvalid).toBe(false)
    expect(derived.unfinished.planEstimate).toBeNull()
    expect(derived.continued.planEstimate).toBeNull()
  })

  it('delta is 0 when the sides add up to the original', () => {
    const derived = deriveSplitDraft(withEstimates('2', '3'))
    expect(derived.originalPoints).toBe(5)
    expect(derived.combinedPoints).toBe(5)
    expect(derived.delta).toBe(0)
  })

  it('delta is POSITIVE when the split adds points', () => {
    const derived = deriveSplitDraft(withEstimates('5', '5'))
    expect(derived.combinedPoints).toBe(10)
    expect(derived.delta).toBe(5)
  })

  it('delta is NEGATIVE when the split loses points', () => {
    const derived = deriveSplitDraft(withEstimates('1', ''))
    expect(derived.combinedPoints).toBe(1)
    expect(derived.delta).toBe(-4)
  })

  it('an invalid estimate contributes 0 to the arithmetic and still does not block (AC7)', () => {
    const derived = deriveSplitDraft(withEstimates('abc', '5'))
    expect(derived.combinedPoints).toBe(5)
    expect(derived.delta).toBe(0)
  })

  it('rounds to the two decimals `numeric(6,2)` actually has', () => {
    // `1.1 + 2.2` is `3.3000000000000003` in binary floating point, and a NON-BLOCKING footer
    // reading `(+0.0000000000000004)` would be visible, wrong and unactionable.
    const derived = deriveSplitDraft(withEstimates('1.1', '2.2'))
    expect(derived.combinedPoints).toBe(3.3)
    expect(derived.delta).toBe(-1.7)
  })

  describe('canConfirm — computed now, wired to the button in SU-06', () => {
    it('is true for an untouched, eligible draft', () => {
      expect(deriveSplitDraft(initSplitDraft(preview())).canConfirm).toBe(true)
    })

    it('is false when a title is blank', () => {
      const draft = initSplitDraft(preview())
      expect(
        deriveSplitDraft({ ...draft, continued: { ...draft.continued, title: ' ' } }).canConfirm,
      ).toBe(false)
    })

    it('is false when an estimate is unparseable', () => {
      expect(deriveSplitDraft(withEstimates('', 'x')).canConfirm).toBe(false)
    })

    it('is false with no target chosen', () => {
      const draft = initSplitDraft(preview())
      expect(deriveSplitDraft({ ...draft, targetIterationId: null }).canConfirm).toBe(false)
    })

    it('is false when the SERVER said the Story is not splittable', () => {
      expect(deriveSplitDraft(initSplitDraft(preview({ eligible: false }))).canConfirm).toBe(false)
    })

    it('is NOT affected by a non-zero delta (BR-13/AC7 — the comparison never blocks)', () => {
      const derived = deriveSplitDraft(withEstimates('5', '5'))
      expect(derived.delta).toBe(5)
      expect(derived.canConfirm).toBe(true)
    })
  })
})

describe('splitPreviewTotals — the footer counts and hours', () => {
  it('counts each collection and sums the Task effort, treating null as absent', () => {
    expect(splitPreviewTotals(preview())).toEqual({
      tasks: 3,
      defects: 1,
      testCases: 1,
      actualHours: 6.5,
      todoHours: 3,
    })
  })

  it('reads a story with no children as zeros', () => {
    expect(splitPreviewTotals(preview({ tasks: [], defects: [], testCases: [] }))).toEqual({
      tasks: 0,
      defects: 0,
      testCases: 0,
      actualHours: 0,
      todoHours: 0,
    })
  })
})

// ── SU-03 / SU-04 / SU-05: distribution ───────────────────────────────────────

describe('move — the three distributions', () => {
  const kinds = [
    { kind: 'task' as const, id: 'ta-2', field: 'unfinishedTaskIds' as const },
    { kind: 'defect' as const, id: 'de-1', field: 'unfinishedDefectIds' as const },
    { kind: 'testCase' as const, id: 'tc-1', field: 'unfinishedTestCaseIds' as const },
  ]

  for (const { kind, id, field } of kinds) {
    it(`moves a ${kind} left and right again`, () => {
      const draft = initSplitDraft(preview())
      const left = splitDraftReducer(draft, { type: 'move', kind, id, side: 'unfinished' })!
      expect(left[field].has(id)).toBe(true)
      const right = splitDraftReducer(left, { type: 'move', kind, id, side: 'continued' })!
      expect(right[field].has(id)).toBe(false)
    })

    it(`moving a ${kind} does not disturb the other two kinds`, () => {
      const draft = initSplitDraft(preview())
      const next = splitDraftReducer(draft, { type: 'move', kind, id, side: 'unfinished' })!
      for (const other of kinds.filter((k) => k.kind !== kind)) {
        expect(next[other.field], other.kind).toBe(draft[other.field])
      }
    })
  }

  it('is a NO-OP, and identity-stable, when the item is already on that side', () => {
    // Returning the same object means React re-renders nothing — and it means a "moved" test cannot
    // pass by asserting against a state that never changed.
    const draft = initSplitDraft(preview())
    // TA-1 already defaults to `[Unfinished]` (BR-14), TA-2 to `[Continued]` (BR-15).
    expect(
      splitDraftReducer(draft, { type: 'move', kind: 'task', id: 'ta-1', side: 'unfinished' }),
    ).toBe(draft)
    expect(
      splitDraftReducer(draft, { type: 'move', kind: 'task', id: 'ta-2', side: 'continued' }),
    ).toBe(draft)
  })

  it('never mutates the set it replaces', () => {
    const draft = initSplitDraft(preview())
    const before = [...draft.unfinishedTaskIds]
    splitDraftReducer(draft, { type: 'move', kind: 'task', id: 'ta-2', side: 'unfinished' })
    expect([...draft.unfinishedTaskIds]).toEqual(before)
  })

  it('moves an item the preview never mentioned without inventing a row', () => {
    // The reducer holds ids, not rows: an id the preview does not carry ends up in the set and simply
    // matches nothing in `rowsOnSide`. Nothing renders and nothing throws — which is what should
    // happen if a child was deleted between the preview and a drop.
    const draft = initSplitDraft(preview())
    const next = splitDraftReducer(draft, {
      type: 'move',
      kind: 'task',
      id: 'ta-does-not-exist',
      side: 'unfinished',
    })!
    expect(
      rowsOnSide(preview().tasks, next.unfinishedTaskIds, 'unfinished').map((t) => t.id),
    ).toEqual(['ta-1'])
  })
})

describe('unfinishedIdsFor / rowsOnSide', () => {
  it('reads each kind’s own set', () => {
    const draft = initSplitDraft(preview())
    expect([...unfinishedIdsFor(draft, 'task')]).toEqual(['ta-1'])
    expect([...unfinishedIdsFor(draft, 'defect')]).toEqual([])
    expect([...unfinishedIdsFor(draft, 'testCase')]).toEqual([])
  })

  it('treats `[Continued]` as the COMPLEMENT, never as a second stored list', () => {
    const draft = initSplitDraft(preview())
    const tasks = preview().tasks
    expect(rowsOnSide(tasks, draft.unfinishedTaskIds, 'unfinished').map((t) => t.id)).toEqual([
      'ta-1',
    ])
    expect(rowsOnSide(tasks, draft.unfinishedTaskIds, 'continued').map((t) => t.id)).toEqual([
      'ta-2',
      'ta-3',
    ])
  })

  it('keeps the PREVIEW’s order, so a row moved away and back does not jump to the end', () => {
    const tasks = preview().tasks
    const draft = initSplitDraft(preview())
    const moved = splitDraftReducer(draft, {
      type: 'move',
      kind: 'task',
      id: 'ta-2',
      side: 'unfinished',
    })!
    const back = splitDraftReducer(moved, {
      type: 'move',
      kind: 'task',
      id: 'ta-2',
      side: 'continued',
    })!
    expect(rowsOnSide(tasks, back.unfinishedTaskIds, 'continued').map((t) => t.id)).toEqual([
      'ta-2',
      'ta-3',
    ])
  })

  it('reads an absent collection as no rows', () => {
    const draft = initSplitDraft(preview())
    expect(rowsOnSide(undefined, draft.unfinishedTaskIds, 'continued')).toEqual([])
  })

  it('an ALL-on-one-side distribution is still confirmable (AC5 — an empty side blocks nothing)', () => {
    let draft = initSplitDraft(preview())
    for (const task of preview().tasks) {
      draft = splitDraftReducer(draft, {
        type: 'move',
        kind: 'task',
        id: task.id,
        side: 'continued',
      })!
    }
    expect(rowsOnSide(preview().tasks, draft.unfinishedTaskIds, 'unfinished')).toEqual([])
    expect(deriveSplitDraft(draft).canConfirm).toBe(true)
  })
})
