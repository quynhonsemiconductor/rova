/**
 * `Resource` — the one seam between a TanStack query and a surface that renders it.
 *
 * Why this exists
 * ---------------
 * `useQuery().data` is `undefined` **both** while the request is in flight and after it has
 * FAILED. The house idiom was `const { data: rows = [] } = useThing(id)`, which collapses those
 * two into one answer — so a 403, a 500 or a 400 from a bad query DTO renders as a confident,
 * plausible *measurement*:
 *
 *   • both Artifacts tabs said "No artifacts linked to this release" for every record, one of them
 *     because every request was a 400;
 *   • Release Tracking printed "No releases in this project — Create one under Plan > Timeboxes",
 *     a fabricated fact plus a wrong call to action, for a cold load or a 500;
 *   • Team Capacity showed four `0h` cards directly above its own error message;
 *   • Iteration Burndown printed "no daily history has been recorded" — a claim about the sprint —
 *     for a 500, and kept its "On track" verdict;
 *   • every project Editor saw `Unassigned` on every owned item, because a 403 on the roster
 *     defaulted to `[]` and the owner NAME is derived from that list.
 *
 * None of those look broken, which is exactly why they survived review, manual testing and the
 * test suite. Counted at the time this file was written: 82 `useQuery(` call sites, **158**
 * defaulting the result, **21** files consulting `isError` anywhere.
 *
 * The contract
 * ------------
 * A `Resource` has a **`phase`**, and `error` is a different phase from `empty`. Branch on
 * `phase`; never on `rows.length` alone. `rows` is deliberately always an array (so `.map`,
 * `.find` and label lookups still work while loading or after a failure) — but because the
 * `phase` travels WITH it in one object, a component whose prop is a `ListResource` cannot be
 * handed a bare `data ?? []`: that is a type error, not a silent fabrication. That is the
 * forcing function. `ActivityHistoryTab` and `ArtifactsTabView` take one, which is why every
 * one of their nine call sites had to be converted rather than opting out.
 *
 * How it fails loudly
 * -------------------
 *   1. **`tsc`** — a shared view whose prop is `ListResource<T>` rejects `T[]`, and rejects an
 *      object literal that omits `phase`/`error`. Forgetting is a compile error at the call site.
 *   2. **The ratchet** — `src/test/query-default.ratchet.test.ts` counts the surviving
 *      `data ?? []` / `data: x = []` call sites per file and may only ever decrease.
 *
 * Do NOT add a `?? []` convenience getter here, and do not widen a view's prop back to a plain
 * array "just for this one caller": both re-open the hole this file closes.
 */

/**
 * The four answers a data surface can honestly give.
 *
 * `empty` and `error` are the two that were conflated. `empty` is a MEASUREMENT ("the server
 * looked and there is nothing"); `error` is the absence of a measurement.
 */
export type ResourcePhase = 'loading' | 'error' | 'empty' | 'ready'

/** The subset of a TanStack `UseQueryResult` this module reads. */
export interface QueryLike<T> {
  data: T | undefined
  isLoading?: boolean
  isPending?: boolean
  isError?: boolean
  error?: unknown
}

interface ResourceBase {
  readonly phase: ResourcePhase
  /** `phase === 'loading'`, kept because most surfaces already have a skeleton branch. */
  readonly isLoading: boolean
  /** `phase === 'error'`. The thing whose absence caused every defect above. */
  readonly isError: boolean
  /** The thrown value, for `errorMessage()`. `undefined` unless `isError`. */
  readonly error: unknown
}

/**
 * A list-shaped resource.
 *
 * `rows` is safe to read in every phase, so derivations (owner-name maps, option lists, totals)
 * do not need a guard. What is NOT safe is treating `rows.length === 0` as a fact — check
 * `phase` first.
 */
export interface ListResource<T> extends ResourceBase {
  /**
   * `T[]`, not `readonly T[]`, on purpose: the seam has to be CHEAPER than the idiom it replaces or
   * it gets bypassed, and a `readonly` array forces a spread at every existing helper that takes
   * `T[]` (`iterationsInScope`, the pickers, `useMemo` filters). The invariant this file defends is
   * "an error is not an empty answer".
   *
   * BUT DO NOT MUTATE IT IN PLACE. Whenever there is no data — loading, error, disabled, or
   * `emptyListResource()` — `rows` is the shared FROZEN `NO_ROWS` array (see there for why it must
   * keep one reference), and `rows.sort(…)` / `rows.push(…)` throws a `TypeError`. That only
   * happens while data is missing, so a fixture that resolves data will not catch it. Copy first:
   * `[...rows].sort(…)`. When data is present, `rows` IS the query cache's array, which must not be
   * mutated either.
   */
  readonly rows: T[]
}

/** A single-value resource (a detail record, a count). */
export interface ValueResource<T> extends ResourceBase {
  /** Defined only when `phase === 'ready'`. */
  readonly value: T | undefined
}

function pending<T>(q: QueryLike<T>): boolean {
  // `isPending` is the v5 name and is true for a disabled query too; `isLoading` is
  // `isPending && isFetching`. Prefer `isLoading` when present so a query parked on a
  // missing id does not render a permanent skeleton.
  return q.isLoading ?? q.isPending ?? false
}

/**
 * The ONE empty array every list resource without data hands out — `listResource` while a query
 * has nothing, and `emptyListResource()`.
 *
 * `q.data ?? []` minted a fresh array on every render while a query was pending (or failed, or
 * disabled). Anything keyed on the REFERENCE of `rows` then saw a change on every render — and
 * `useRowRerank` re-syncs its optimistic copy DURING render when its `items` reference changes, so a
 * Tasks or Test Cases tab that re-rendered before its fetch resolved set state, re-rendered, got
 * another new `[]`, and hit React's "Too many re-renders" (minified error 301). Production, 2026-10-05:
 * opening the Tasks tab on US-120 replaced the page with the error boundary.
 *
 * Frozen so a caller that mutates it throws instead of corrupting every other empty resource.
 */
const NO_ROWS: readonly never[] = Object.freeze([])

/**
 * Wrap a list query. Pass the query result itself, not `query.data`.
 *
 * ```ts
 * const activityQuery = useActivityLog(id)
 * const logs = listResource(activityQuery)
 * // logs.phase → 'loading' | 'error' | 'empty' | 'ready'
 * ```
 *
 * **Bind the hook to its own const first.** `listResource(useActivityLog(id))` compiles and behaves
 * identically, but the React Compiler cannot see through a hook call used as a plain function's
 * ARGUMENT: it stops trusting the surrounding component and reports
 * `Compilation Skipped: Existing memoization could not be preserved` on an unrelated `useCallback`
 * further down the file (it did exactly that on `team-status-page.tsx`, ~40 lines away from the
 * change). The two-line form is not a style preference; it is what keeps the whole component
 * optimisable, and `pnpm lint` fails on the one-line form.
 */
export function listResource<T>(q: QueryLike<T[]>): ListResource<T> {
  const rows = q.data ?? (NO_ROWS as unknown as T[])
  const isError = q.isError === true
  const isLoading = pending(q) && !isError
  return {
    rows,
    isError,
    isLoading,
    error: isError ? q.error : undefined,
    phase: isError ? 'error' : isLoading ? 'loading' : rows.length === 0 ? 'empty' : 'ready',
  }
}

/**
 * Wrap a single-record query. `phase` is `empty` when the request succeeded and the record is
 * genuinely absent (a 404 mapped to `null`), which is a different sentence from "could not load".
 */
export function valueResource<T>(q: QueryLike<T>): ValueResource<T> {
  const isError = q.isError === true
  const isLoading = pending(q) && !isError
  const missing = !isLoading && !isError && (q.data === undefined || q.data === null)
  return {
    value: isError || isLoading ? undefined : (q.data ?? undefined),
    isError,
    isLoading,
    error: isError ? q.error : undefined,
    phase: isError ? 'error' : isLoading ? 'loading' : missing ? 'empty' : 'ready',
  }
}

/**
 * Combine several resources into one for a surface that cannot render a partial answer.
 *
 * Error wins over loading: a screen that failed one of its five feeds must not sit on a
 * skeleton forever waiting for the others. Reports use this for their picker feed + their own
 * series, which is how a failing `/v1/iterations` stops reading as "select an iteration".
 */
export function combinePhase(...parts: readonly ResourceBase[]): ResourcePhase {
  if (parts.some((p) => p.isError)) return 'error'
  if (parts.some((p) => p.isLoading)) return 'loading'
  return 'ready'
}

/** First error among several resources, for the message. */
export function firstError(...parts: readonly ResourceBase[]): unknown {
  return parts.find((p) => p.isError)?.error
}

/**
 * A resource that is not backed by a request. For a surface whose feed is genuinely absent
 * (no id selected yet), so it can still satisfy a `ListResource` prop without pretending the
 * server answered.
 */
export function emptyListResource<T>(): ListResource<T> {
  return {
    rows: NO_ROWS as unknown as T[],
    phase: 'empty',
    isLoading: false,
    isError: false,
    error: undefined,
  }
}
