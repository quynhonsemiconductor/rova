/**
 * Split a User Story — the preview feed.
 *
 * Its own file rather than a section of `api.ts`, for the reason `story-options.ts` gives: that
 * module is the SPA file-length ratchet holder (`fe-consistency.ratchet.test.ts`, 929), and this is
 * a self-contained question. Re-exported from `api.ts` so call sites import from the one barrel.
 *
 * **The server owns the eligibility rule.** This hook fetches an answer; it does not compute one.
 * `eligible` is the only field a caller may branch on — `ineligibleReason` exists for telemetry and
 * tests and must NEVER be rendered (SRS §11: the control is disabled with no explanatory message).
 * Re-deriving "is this splittable" in the browser would put half a rule in TypeScript and half in
 * SQL, which is the fault class the plan risk register calls "a picker narrower than the write".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import type { components } from '@/shared/api/generated/api'

/** Generated from the served OpenAPI spec — never hand-written. */
export type SplitPreview = components['schemas']['SplitPreviewResponseDto']
export type SplitPreviewTarget = SplitPreview['targets'][number]
export type SplitPreviewTask = SplitPreview['tasks'][number]
export type SplitPreviewDefect = SplitPreview['defects'][number]
export type SplitPreviewTestCase = SplitPreview['testCases'][number]
export type SplitSide = SplitPreviewTask['defaultSide']

/**
 * Its own cache key, deliberately NOT reaching into `workItemKeys` in `api.ts`: that module
 * re-exports this one, and importing back would make the pair circular. Same `['work-items']`
 * prefix, so a broad work-item invalidation still reaches it — which is what SU-06 needs after a
 * confirmed split.
 */
export const splitPreviewKey = (workItemId: string) =>
  ['work-items', 'split-preview', workItemId] as const

/**
 * One Story's split preview.
 *
 * Returns the QUERY, not a `Resource`: `resource.ts` requires the hook to be bound to its own const
 * at the call site before wrapping (`const q = useSplitPreview(...); const r = valueResource(q)`),
 * because the React Compiler cannot see through a hook used as a function argument and reports
 * `Compilation Skipped` on unrelated memoisation further down the file. `pnpm lint` fails on the
 * one-line form.
 *
 * `enabled` is a NARROWING and nothing more. The Iteration Status entry point passes
 * `selection.count === 1 && row.type === 'story'` purely to avoid a request that cannot succeed —
 * it must never be widened into a second copy of the eligibility rule, and it can only ever ask
 * fewer questions than the server would answer.
 *
 * A plain `Error` rather than `ApiError`: no surface branches on the STATUS here. A reader without
 * `work_item:view` never reaches a Story detail page at all, and the preview's own "you may not
 * edit this" outcome is a 200 carrying `ineligibleReason: 'not_editable'` — deliberately not a 403,
 * so "you may not split this" and "this cannot be split" stay distinguishable server-side while
 * looking identical on screen.
 */
export function useSplitPreview(
  workItemId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: splitPreviewKey(workItemId ?? ''),
    queryFn: async (): Promise<SplitPreview | null> => {
      if (!workItemId) return null
      const { data, error, response } = await apiClient.GET('/v1/work-items/{id}/split-preview', {
        params: { path: { id: workItemId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? null
    },
    enabled: enabled && !!workItemId,
    // Short: eligibility turns on the Story schedule state and its Iteration, both of which the
    // reader can change on the same page seconds before opening the menu.
    staleTime: 10_000,
  })
}

// ── The write (SU-06) ─────────────────────────────────────────────────────────

/** Generated from the served spec — the body the server accepts, never hand-typed. */
export type SplitWorkItemInput = components['schemas']['SplitWorkItemDto']
export type SplitWorkItemResult = components['schemas']['SplitWorkItemResponseDto']
export type StorySplit = SplitWorkItemResult['split']

/**
 * Commit one complete Split.
 *
 * HERE AND NOT IN `api.ts`, like `useSplitPreview` above: that module holds the SPA's file-length
 * ratchet at 929 and sat at 923 before this PR. SU-01's 1.7 note said everything the Split adds to
 * the api layer lands in this file, and this is that.
 *
 * **`meta: { invalidates: ['work-item'] }` plus TWO explicit keys.** The shared `work-item` fan-out
 * covers every work-item-derived read model (Backlog, Iteration Status, Team Status, Quality,
 * Portfolio, My Work, counts) — but a Split also changes two things that are NOT keyed on a work
 * item: the split PREVIEW of the Story that just moved (its eligibility, defaults and target list are
 * all now different), and the REPORTS, because points and To Do have crossed an iteration boundary.
 * Invalidating those explicitly is cheaper than widening the shared prefix for every other mutation.
 *
 * The caller owns navigation: `onSuccess` in the modal closes it and routes to `[Continued]`, which is
 * SU-07 AC1's landing. Putting the `navigate` here would make this hook un-callable from anywhere
 * without a router.
 */
export function useSplitWorkItem(workItemId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SplitWorkItemInput): Promise<SplitWorkItemResult> => {
      const { data, error, response } = await apiClient.POST('/v1/work-items/{id}/split', {
        params: { path: { id: workItemId } },
        body: input,
      })
      // The server's own message is kept: every refusal here is one the reader can act on — the
      // Story moved, the target is no longer valid, a child is gone — and a generic "split failed"
      // would throw that away.
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as SplitWorkItemResult
    },
    meta: { invalidates: ['work-item'] },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: splitPreviewKey(workItemId) })
      void qc.invalidateQueries({ queryKey: ['reports'] })
    },
  })
}
