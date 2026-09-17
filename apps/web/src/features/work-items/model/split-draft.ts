/**
 * SplitDraft — the Split modal's edit state, as ONE reducer.
 *
 * A reducer rather than a dozen `useState`s, for a reason that is about correctness and not taste:
 * the two sides, the target Iteration, the three distribution sets and the point comparison are one
 * state machine. Scattered across `useState` they can hold combinations no server call could
 * produce — a target that is not in the offered set, an estimate parsed twice with two answers — and
 * every SU-03/04/05 addition would have to re-derive the point footer from whatever it could reach.
 * Here the whole draft is one value, so it is testable WITHOUT A DOM (`model/split-draft.test.ts`)
 * and the view is a pure function of it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 *  • It does not decide eligibility, default titles, default sides or which Iterations are valid.
 *    Every one of those arrives from `GET /work-items/:id/split-preview`, already decided
 *    (BR-05/06/12/14/15, §8 Q10). Re-deriving any of them in the browser is the second-copy fault
 *    §8 Q17 forbids — and specifically: there is NO `stripSplitPrefix` here. The preview's
 *    `defaults.unfinishedTitle` / `continuedTitle` are already prefix-stripped server-side, so a
 *    re-split cannot stack prefixes, and the way to prove that is to assert the value the preview
 *    handed us rather than to re-run the regex.
 *  • It holds no `useState`, no effects and no React import: `SplitStoryModal` owns the `useReducer`.
 *
 * PLAN ESTIMATE IS HELD AS TEXT, PARSED SEPARATELY
 * ------------------------------------------------
 * A half-typed `-` or `.` must not be coerced to `0`, and an EMPTY field is a legal value — an
 * unpointed Story is `planEstimate: null`, which is NOT `0` (§3.2, and the DTO says so). So the
 * field of record is `planEstimateText` and {@link parsePlanEstimate} answers separately with
 * `{ value, invalid }`. `combinedPoints` treats `null` as `0` for the arithmetic only; the field
 * itself round-trips `null`.
 *
 * `canConfirm` IS EXPORTED AND IS NOT WIRED TO THE BUTTON YET
 * ----------------------------------------------------------
 * SU-02 renders `Split story` unconditionally DISABLED (§8 Q14 / D13 — the write path lands whole in
 * SU-06), so nothing consumes `canConfirm` today. It is computed here anyway because it is a property
 * of the draft, not of the button: **SU-06 plugs the confirm control into
 * `deriveSplitDraft(draft).canConfirm` and removes the unconditional `disabled` + tooltip together.**
 * It already accounts for the server's `eligible`, a chosen target, and both validity rules, so SU-06
 * adds no new condition.
 */
import type { ScheduleState } from '@/entities/work-item/model/types'
import type { SplitPreview, SplitSide } from '@/features/work-items/api'

// ── State ─────────────────────────────────────────────────────────────────────

/** The fields both sides share. */
export interface SplitSideDraft {
  title: string
  /** TEXT of record — see the module docblock. Parse with {@link parsePlanEstimate}. */
  planEstimateText: string
}

/**
 * The `[Continued]` side additionally owns Release and Schedule State, because it is the side that
 * keeps living: BR-11 says it keeps project/team/feature/release unless the reader edits them. The
 * `[Unfinished]` side has no such fields in the draft AT ALL — its Release is `Unscheduled` and its
 * Schedule State is `Accepted` by rule (BR-09/BR-10), not by choice, so there is nothing to hold.
 */
export interface SplitContinuedDraft extends SplitSideDraft {
  releaseId: string | null
  scheduleState: ScheduleState
}

export interface SplitDraft {
  readonly unfinished: SplitSideDraft
  readonly continued: SplitContinuedDraft
  /** `null` = no selection. The preview reports that case as `eligible: false` / `no_target`. */
  readonly targetIterationId: string | null
  /**
   * Exactly the preview's `targets`, ids only, in the order given (earliest first — BR-06/AC5).
   *
   * Held so the DRAFT itself cannot come to name a target the write path would refuse: a picker
   * wider than the write is the fault class the plan's risk register names, and a reducer that
   * accepted any string would be that picker. {@link splitDraftReducer} ignores an id absent here.
   */
  readonly allowedTargetIds: readonly string[]
  /**
   * The three distributions, as the ids sitting on the `[Unfinished]` side. The `[Continued]` side is
   * the complement — the same shape the write path takes (§3.2), so a child added to the Story after
   * the modal opened cannot be silently dropped.
   *
   * SEEDED from the preview's server-decided `defaultSide` (BR-14: a Completed Task defaults left;
   * BR-15: Defects and Test Cases default right). SU-03/04/05 add the UI that MOVES them and the
   * reducer action for it; nothing in SU-02 reads them, which is why there is no move action yet.
   */
  readonly unfinishedTaskIds: ReadonlySet<string>
  readonly unfinishedDefectIds: ReadonlySet<string>
  readonly unfinishedTestCaseIds: ReadonlySet<string>
  /** The Story's Plan Estimate BEFORE the split (BR-13's "original"). `null` = unpointed, not 0. */
  readonly originalPlanEstimate: number | null
  /**
   * The server's answer, snapshotted at seed time — the ANSWER, never the rule (SRS §11). It is here
   * so `canConfirm` is a pure function of the draft; `SplitStoryModal` re-seeds the draft whenever
   * the preview changes, so a Story that stopped being splittable while the modal was open re-seeds
   * with `eligible: false`.
   */
  readonly eligible: boolean
}

/**
 * `null` until the preview lands. Distinct from "an empty draft": there is nothing to edit before
 * the server has said what the defaults are, and a blank draft would render blank fields that the
 * arriving preview then overwrote under the reader's cursor.
 */
export type SplitDraftState = SplitDraft | null

/**
 * The three distributable child kinds. Named for the preview's own collection keys (`tasks`,
 * `defects`, `testCases`) so a move action, a droppable id and a payload field cannot drift apart.
 */
export type SplitItemKind = 'task' | 'defect' | 'testCase'

export type SplitDraftAction =
  /** (Re-)seed from a preview. The only action that can create a draft. */
  | { type: 'reset'; preview: SplitPreview }
  | { type: 'title'; side: SplitSide; value: string }
  | { type: 'planEstimate'; side: SplitSide; value: string }
  | { type: 'releaseId'; value: string | null }
  | { type: 'scheduleState'; value: ScheduleState }
  | { type: 'targetIteration'; value: string }
  /** SU-03/04/05 — move one child to one side. Idempotent: moving it where it already is is a no-op. */
  | { type: 'move'; kind: SplitItemKind; id: string; side: SplitSide }

// ── Parsing ───────────────────────────────────────────────────────────────────

export interface ParsedPlanEstimate {
  /** `null` for an empty field — a legal, unpointed value — and for unparseable text. */
  value: number | null
  /** Non-empty text that is not a number ≥ 0. An EMPTY field is never invalid. */
  invalid: boolean
}

/**
 * Parse one estimate field.
 *
 * Empty is checked BEFORE `Number()`, because `Number('')` and `Number(' ')` are both `0` — the
 * exact coercion that would turn "unpointed" into "worth nothing".
 */
export function parsePlanEstimate(text: string): ParsedPlanEstimate {
  const trimmed = text.trim()
  if (trimmed === '') return { value: null, invalid: false }
  const parsed = Number(trimmed)
  // `Number.isFinite` rejects `NaN` (a half-typed `-` or `.`, any word) and `Infinity`.
  if (!Number.isFinite(parsed) || parsed < 0) return { value: null, invalid: true }
  return { value: parsed, invalid: false }
}

// ── Seeding ───────────────────────────────────────────────────────────────────

function estimateText(planEstimate: number | null): string {
  return planEstimate === null ? '' : String(planEstimate)
}

/** The ids the SERVER put on the `[Unfinished]` side. Never re-derived here (BR-14/15). */
function unfinishedIds(
  rows: readonly { id: string; defaultSide: SplitSide }[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (rows ?? []).filter((row) => row.defaultSide === 'unfinished').map((row) => row.id),
  )
}

/**
 * Seed a draft from a preview.
 *
 * Every default comes from the payload: the two titles from `defaults` (already prefix-stripped,
 * §8 Q10), the target from `defaults.targetIterationId` (BR-06's earliest valid target, `null` when
 * there is none), both estimates from the Story's own (BR-12: "both default to the original,
 * independently editable"), and `[Continued]`'s Release and Schedule State from the Story's current
 * values (BR-11: it keeps them unless edited).
 *
 * Tolerant of a missing collection (`?? []`) even though the DTO types them as present: this seeds
 * from a network payload, and an absent array must read as "none" rather than throw inside a modal
 * that has already opened.
 */
export function initSplitDraft(preview: SplitPreview): SplitDraft {
  const text = estimateText(preview.story.planEstimate)
  return {
    unfinished: { title: preview.defaults.unfinishedTitle, planEstimateText: text },
    continued: {
      title: preview.defaults.continuedTitle,
      planEstimateText: text,
      releaseId: preview.story.releaseId,
      scheduleState: preview.story.scheduleState,
    },
    targetIterationId: preview.defaults.targetIterationId,
    allowedTargetIds: (preview.targets ?? []).map((target) => target.id),
    unfinishedTaskIds: unfinishedIds(preview.tasks),
    unfinishedDefectIds: unfinishedIds(preview.defects),
    unfinishedTestCaseIds: unfinishedIds(preview.testCases),
    originalPlanEstimate: preview.story.planEstimate,
    eligible: preview.eligible,
  }
}

// ── Reducer ───────────────────────────────────────────────────────────────────

function withSide(state: SplitDraft, side: SplitSide, patch: Partial<SplitSideDraft>): SplitDraft {
  return side === 'unfinished'
    ? { ...state, unfinished: { ...state.unfinished, ...patch } }
    : { ...state, continued: { ...state.continued, ...patch } }
}

/** The draft field holding the `[Unfinished]`-side ids for one kind. One map, no `switch` per call. */
const UNFINISHED_FIELD = {
  task: 'unfinishedTaskIds',
  defect: 'unfinishedDefectIds',
  testCase: 'unfinishedTestCaseIds',
} as const satisfies Record<SplitItemKind, keyof SplitDraft>

/**
 * The ids on the `[Unfinished]` side for one kind.
 *
 * Exported so a view never reaches for `draft.unfinishedTestCaseIds` by name: the kind is the thing
 * the view knows (it is rendering a Test Case collection), and the field name is this module's
 * business. It is also what makes {@link rowsOnSide} usable from one generic component.
 */
export function unfinishedIdsFor(draft: SplitDraft, kind: SplitItemKind): ReadonlySet<string> {
  return draft[UNFINISHED_FIELD[kind]]
}

/**
 * The rows belonging to one side — the `[Continued]` side being the COMPLEMENT of the
 * `[Unfinished]` set, never a second stored list.
 *
 * One stored set per kind rather than two lists, because two lists can disagree: an id in both, or
 * in neither, is representable, and the write path (§3.2) submits the `unfinished*` side and derives
 * the complement server-side for the same reason. Order always comes from the PREVIEW's array, so a
 * row that moves right and back lands where it started instead of at the end of the list.
 */
export function rowsOnSide<T extends { id: string }>(
  rows: readonly T[] | undefined,
  unfinished: ReadonlySet<string>,
  side: SplitSide,
): T[] {
  const wanted = side === 'unfinished'
  return (rows ?? []).filter((row) => unfinished.has(row.id) === wanted)
}

function withMove(state: SplitDraft, kind: SplitItemKind, id: string, side: SplitSide): SplitDraft {
  const field = UNFINISHED_FIELD[kind]
  const current = state[field]
  // Idempotent, and identity-stable: a drop onto the side an item already occupies returns the SAME
  // state object, so React re-renders nothing and a "moved" test cannot pass on a no-op.
  if (current.has(id) === (side === 'unfinished')) return state
  const next = new Set(current)
  if (side === 'unfinished') next.add(id)
  else next.delete(id)
  return { ...state, [field]: next }
}

export function splitDraftReducer(
  state: SplitDraftState,
  action: SplitDraftAction,
): SplitDraftState {
  // The one action that does not need a draft to exist — it is what brings one into being.
  if (action.type === 'reset') return initSplitDraft(action.preview)
  if (state === null) return state
  switch (action.type) {
    case 'title':
      return withSide(state, action.side, { title: action.value })
    case 'planEstimate':
      return withSide(state, action.side, { planEstimateText: action.value })
    case 'releaseId':
      return { ...state, continued: { ...state.continued, releaseId: action.value } }
    case 'scheduleState':
      return { ...state, continued: { ...state.continued, scheduleState: action.value } }
    case 'targetIteration':
      // Restricted to the offered set, and silently: the picker only ever renders these ids, so a
      // rejection here is a defect upstream, not something to tell the reader about.
      return state.allowedTargetIds.includes(action.value)
        ? { ...state, targetIterationId: action.value }
        : state
    case 'move':
      return withMove(state, action.kind, action.id, action.side)
  }
}

// ── Derived ───────────────────────────────────────────────────────────────────

export interface SplitSideDerived {
  /** The parsed estimate. `null` = the field is empty (legal) or unparseable. */
  planEstimate: number | null
  /** Blank or whitespace-only title (AC6). */
  titleInvalid: boolean
  estimateInvalid: boolean
}

export interface SplitDerived {
  unfinished: SplitSideDerived
  continued: SplitSideDerived
  /** Either side's title is invalid. */
  titleInvalid: boolean
  /** Either side's estimate is invalid. */
  estimateInvalid: boolean
  /** SU-06's gate on the confirm control — see the module docblock. Unused in SU-02. */
  canConfirm: boolean
  /** BR-13's comparison. `delta` is NON-BLOCKING: it never contributes to `canConfirm` (AC7). */
  originalPoints: number
  combinedPoints: number
  delta: number
}

/**
 * `story_points` is `numeric(6,2)`, so two decimals is the whole domain — but `1.1 + 2.2` in binary
 * floating point is `3.3000000000000003`, and a footer reading `(+0.0000000000000004)` would be a
 * defect in a NON-BLOCKING display (BR-13), which is the worst kind: visible, wrong, and impossible
 * for the reader to act on.
 */
function roundPoints(points: number): number {
  return Math.round(points * 100) / 100
}

function deriveSide(side: SplitSideDraft): SplitSideDerived {
  const estimate = parsePlanEstimate(side.planEstimateText)
  return {
    planEstimate: estimate.value,
    titleInvalid: side.title.trim() === '',
    estimateInvalid: estimate.invalid,
  }
}

export function deriveSplitDraft(draft: SplitDraft): SplitDerived {
  const unfinished = deriveSide(draft.unfinished)
  const continued = deriveSide(draft.continued)
  const titleInvalid = unfinished.titleInvalid || continued.titleInvalid
  const estimateInvalid = unfinished.estimateInvalid || continued.estimateInvalid
  const originalPoints = draft.originalPlanEstimate ?? 0
  const combinedPoints = roundPoints((unfinished.planEstimate ?? 0) + (continued.planEstimate ?? 0))
  return {
    unfinished,
    continued,
    titleInvalid,
    estimateInvalid,
    canConfirm:
      draft.eligible && draft.targetIterationId !== null && !titleInvalid && !estimateInvalid,
    originalPoints,
    combinedPoints,
    delta: roundPoints(combinedPoints - originalPoints),
  }
}

// ── Footer totals ─────────────────────────────────────────────────────────────

/** The counts and hours half of the footer summary (2.5). The points half is {@link SplitDerived}. */
export interface SplitPreviewTotals {
  tasks: number
  defects: number
  testCases: number
  actualHours: number
  todoHours: number
}

function sumHours(values: readonly (number | null)[]): number {
  return roundPoints(values.reduce<number>((total, value) => total + (value ?? 0), 0))
}

/**
 * What the split is carrying, from the preview alone: how many children of each kind, and the Task
 * effort behind them.
 *
 * Here rather than in the view because it is arithmetic, and the view has no business doing
 * arithmetic (the plan's risk register: "the reducer holds the logic, not the view"). Whole-story
 * totals, not per side — SU-02 has no collections to distribute yet, and a per-side count arrives
 * with the collections in SU-03/04/05.
 */
export function splitPreviewTotals(preview: SplitPreview): SplitPreviewTotals {
  const tasks = preview.tasks ?? []
  return {
    tasks: tasks.length,
    defects: (preview.defects ?? []).length,
    testCases: (preview.testCases ?? []).length,
    actualHours: sumHours(tasks.map((task) => task.actualHours)),
    todoHours: sumHours(tasks.map((task) => task.todoHours)),
  }
}
