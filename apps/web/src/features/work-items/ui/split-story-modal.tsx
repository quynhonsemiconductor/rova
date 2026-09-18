/**
 * SplitStoryModal — the two-panel Split dialog, opened from the kebab on a Story's detail header or
 * from the Iteration Status bulk bar.
 *
 * WHAT IT IS. One `GET /work-items/:id/split-preview` fills it, and the SERVER owns every rule in it:
 * eligibility, the default titles, which Iterations are valid targets, and which side each Task /
 * Defect / Test Case starts on. This component renders that answer and never re-derives it (§8 Q17 —
 * a browser-side copy of a rule the write path enforces is the "picker narrower than the write" fault
 * class with the two halves in different languages). One `useReducer` over `model/split-draft.ts`
 * holds the whole edit state — both sides' fields, the chosen target, the three distribution sets —
 * so the view is a pure function of one value. `Split story` is enabled by the draft's own
 * `canConfirm` and POSTs `/work-items/:id/split`; on success the modal closes and navigates to
 * `[Continued]`.
 *
 * BUILT ON THE SHARED SHELL, not the mockup's `fixed inset-0` div: `AppModal` supplies the focus
 * trap, Escape-to-close, body scroll lock, `role="dialog"` + `aria-labelledby`, and the `maxHeight`
 * that makes `ModalBody` actually scroll instead of pushing the footer off-screen.
 *
 * WHAT IS DELIBERATELY ABSENT — assert the absences, they are the part most likely to regress
 * because adding a helpful message feels like an improvement (SRS §11):
 *   • `ineligibleReason` is NEVER rendered. The server sends it for telemetry and tests; every AC
 *     says the action is simply unavailable, with no explanation.
 *   • no toast, no validation text, no warning styling. The ONE message this modal renders is a
 *     failed WRITE, beside the control that failed — see {@link confirmSplit} for why a refused
 *     transaction is not validation copy.
 *
 * NOT YET READ ANYWHERE ON SCREEN: a confirmed Split links the two Stories in `work.story_splits`,
 * and neither Story's detail page shows its counterpart.
 */
import { useEffect, useReducer, useState } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { valueResource } from '@/shared/lib/query/resource'
import { formatNumber, formatPoints } from '@/shared/lib/utils'
import { useRerankSensors } from '@/shared/ui/table/use-row-rerank'
import { useSplitPreview, useSplitWorkItem } from '@/features/work-items/api'
import type { SplitPreview, SplitSide } from '@/features/work-items/api'
import {
  deriveSplitDraft,
  splitDraftReducer,
  splitPreviewTotals,
  type SplitDerived,
  type SplitDraft,
  type SplitItemKind,
} from '@/features/work-items/model/split-draft'
import { SplitStoryPanel } from '@/features/work-items/ui/split-story-panel'

/**
 * Build the write payload from the draft (SU-06).
 *
 * `[Unfinished]` side only — the server derives `[Continued]` as the complement of the Story's live
 * children, so a child added after the modal opened cannot be silently dropped. `expectedSourceIterationId`
 * is D9's optimistic echo: the source Iteration this modal RENDERED, not one re-read at submit time,
 * which is the whole point (re-reading it would defeat the check).
 *
 * `targetIterationId` is non-null by the time this runs — `canConfirm` requires it — and the `??` is
 * the type system's price for that, not a second rule.
 */
function toSplitPayload(draft: SplitDraft, derived: SplitDerived, preview: SplitPreview) {
  return {
    expectedSourceIterationId: preview.story.iterationId ?? '',
    targetIterationId: draft.targetIterationId ?? '',
    unfinished: {
      title: draft.unfinished.title.trim(),
      planEstimate: derived.unfinished.planEstimate,
    },
    continued: {
      title: draft.continued.title.trim(),
      planEstimate: derived.continued.planEstimate,
      releaseId: draft.continued.releaseId,
      scheduleState: draft.continued.scheduleState,
    },
    unfinishedTaskIds: [...draft.unfinishedTaskIds],
    unfinishedDefectIds: [...draft.unfinishedDefectIds],
    unfinishedTestCaseIds: [...draft.unfinishedTestCaseIds],
  }
}

export function SplitStoryModal({
  open,
  onClose,
  workItemId,
  itemKey,
  title,
}: {
  open: boolean
  onClose: () => void
  workItemId: string
  /** Rendered in the modal title. Held by both entry points already, so no extra round trip. */
  itemKey: string
  title: string
}) {
  const { t } = useTranslation('split-story')
  const navigate = useNavigate()

  // Bound to its own const BEFORE `valueResource`, as `resource.ts` requires: the React Compiler
  // cannot see through a hook call used as a function argument and reports `Compilation Skipped` on
  // unrelated memoisation elsewhere in the file. `pnpm lint` fails on the one-line form.
  //
  // Gated on `open` so the request is made when the reader asks for the modal, not on every render
  // of the page behind it.
  const previewQuery = useSplitPreview(workItemId, { enabled: open })
  const preview = valueResource(previewQuery)
  const previewValue = preview.value

  /**
   * ONE reducer for the whole draft (`model/split-draft.ts`), seeded from the preview.
   *
   * `null` until the payload lands, because the defaults are the server's: seeding an empty draft
   * first would render blank fields that the arriving preview then overwrote under the reader's
   * cursor. The effect re-seeds whenever the preview OBJECT changes — a refetch that reports the
   * Story is no longer splittable re-seeds with `eligible: false` rather than leaving a stale draft
   * that thinks it still is.
   */
  const [draft, dispatch] = useReducer(splitDraftReducer, null)
  useEffect(() => {
    if (previewValue) dispatch({ type: 'reset', preview: previewValue })
  }, [previewValue])
  const derived = draft ? deriveSplitDraft(draft) : null

  /**
   * The `DndContext` lives HERE, not in the collection, because a drag has to cross from one panel to
   * the other — dnd-kit only pairs a draggable with a droppable under a common context. The sensors
   * are the shared `useRerankSensors()` set (§8 Q17: never a hand-rolled drag), whose 4px pointer
   * activation constraint is also what keeps a click on a row's arrow button from starting a drag.
   */
  const sensors = useRerankSensors()

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over) return
    const from = active.data.current as { kind?: SplitItemKind; id?: string; side?: SplitSide }
    const to = over.data.current as { kind?: SplitItemKind; side?: SplitSide }
    // Same KIND only: a Task dropped on the Test Cases list is not a move, it is a miss. And a drop
    // on the side the row already occupies is refused here rather than dispatched as a no-op.
    if (!from?.kind || !from.id || !to?.side) return
    if (from.kind !== to.kind || from.side === to.side) return
    dispatch({ type: 'move', kind: from.kind, id: from.id, side: to.side })
  }

  /**
   * The write (SU-06). Nothing about the modal's shape changed — the button that was disabled with a
   * tooltip since SU-01 is now the same button, enabled by `derived.canConfirm`.
   *
   * `submitError` is modal-level, not field-level: every refusal the server can return here is about
   * the SPLIT (the Story moved, the target is no longer valid, a child is gone), not about one input,
   * and putting it under a field would point at the wrong thing. It is the ONE message this modal is
   * allowed to render — AC6/SRS §12 forbid validation text, and a failed WRITE is not validation.
   */
  const splitStory = useSplitWorkItem(workItemId)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function confirmSplit() {
    if (!draft || !derived || !previewValue || !derived.canConfirm) return
    setSubmitError(null)
    try {
      const result = await splitStory.mutateAsync(toSplitPayload(draft, derived, previewValue))
      onClose()
      /**
       * SU-07 AC1's landing, and it is this mutation's `onSuccess` because the navigation TARGET is
       * something only the response knows: `[Continued]` keeps the original id but the reader may have
       * arrived from the Iteration Status bulk bar, where "the page I am on" is not that Story.
       * Navigating by `itemKey` rather than id uses the route the rest of the app links with.
       */
      void navigate({ to: '/item/$itemKey', params: { itemKey: result.continued.itemKey } })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('error.submit'))
    }
  }

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={t('modal.title', { key: itemKey, title })}
      width={880}
    >
      <ModalBody className="space-y-4">
        {preview.isLoading ? (
          <p className="text-ui-sm text-foreground-subtle">{t('loading')}</p>
        ) : preview.isError ? (
          // `isError` is read explicitly. `value` is `undefined` both in flight and after a failure,
          // so a surface that only checked for absence would render an empty split as a fact.
          <LoadErrorState error={preview.error} title={t('error.title')} size="sm" />
        ) : previewValue ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section aria-labelledby="split-panel-unfinished" className="space-y-2">
                <h3
                  id="split-panel-unfinished"
                  className="text-ui-sm font-semibold text-foreground"
                >
                  {previewValue.story.iterationName
                    ? t('panels.unfinished', { iteration: previewValue.story.iterationName })
                    : t('panels.unfinishedNoIteration')}
                </h3>
                {draft && derived && (
                  <SplitStoryPanel
                    side="unfinished"
                    preview={previewValue}
                    draft={draft}
                    derived={derived}
                    dispatch={dispatch}
                  />
                )}
              </section>
              <section aria-labelledby="split-panel-continued" className="space-y-2">
                <h3 id="split-panel-continued" className="text-ui-sm font-semibold text-foreground">
                  {t('panels.continued')}
                </h3>
                {draft && derived && (
                  <SplitStoryPanel
                    side="continued"
                    preview={previewValue}
                    draft={draft}
                    derived={derived}
                    dispatch={dispatch}
                  />
                )}
              </section>
            </div>
          </DndContext>
        ) : null}
      </ModalBody>
      <ModalFooter className="justify-between">
        {derived && previewValue ? (
          <SplitFooterSummary preview={previewValue} derived={derived} />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {/*
            The ONE message this modal renders: a failed WRITE. Not validation copy (AC6 / SRS §12
            forbid that and no field carries a message), and not a toast — it belongs beside the
            control that failed, and it must survive so the reader can retry or cancel.
          */}
          {submitError && (
            <span role="alert" className="text-ui-sm text-destructive">
              {submitError}
            </span>
          )}
          <Button variant="outline" onClick={onClose} disabled={splitStory.isPending}>
            {t('modal.cancel')}
          </Button>
          {/*
            ENABLED, at last (SU-06). `canConfirm` is the reducer's — server-decided eligibility, a
            chosen target, and both sides valid — which is exactly what SU-02 computed and left
            unwired. The tooltip is gone with the `disabled`: the button no longer has to explain
            itself, and while a split is in flight the label says what is happening.
          */}
          <Button disabled={!derived?.canConfirm || splitStory.isPending} onClick={confirmSplit}>
            {splitStory.isPending ? t('modal.confirming') : t('modal.confirm')}
          </Button>
        </div>
      </ModalFooter>
    </AppModal>
  )
}

/**
 * `+3` / `-2` / `0` — the sign is the whole point of the comparison (BR-13).
 *
 * The NUMBER is delegated to `formatPoints`, so the digits, the decimal mark and the group separator
 * are the reader's locale's; only the leading `+` is added here. There is no existing signed
 * formatter in `shared/lib` to reuse — `formatPoints`/`formatNumber`/`formatPercent` are all
 * unsigned — so this stays local, but it must never format the number itself.
 */
function formatDelta(delta: number): string {
  const formatted = formatPoints(delta)
  return delta > 0 ? `+${formatted}` : formatted
}

/**
 * The footer summary (2.5) — what the split is carrying, and what it does to the points.
 *
 * NON-BLOCKING, and that is a business rule, not a style choice: BR-13/AC7 say the reader may split
 * 5 points into 3 + 4 and save it. So the token shifts (success when the sides still add up to the
 * original, warning when they do not) and NOTHING else changes — the delta reaches no `disabled` and
 * no message. Tokens, never raw hex.
 *
 * EVERY NUMBER GOES THROUGH `Intl`, via `formatPoints`/`formatNumber` (review follow-up, 2026-09-17).
 * The locale is per-user then per-workspace (`resolveFormatPrefs`: `user?.locale || workspace?.locale
 * || 'en'`), and the i18n layer does NOT compensate — `i18n.ts` configures only
 * `interpolation: { escapeValue: false }`, with no format function, and these strings interpolate a
 * bare `{{original}}` rather than `{{original, number}}`. So a raw number here would render through
 * default JS stringification (`1234.5`) while every other numeric surface in the app renders through
 * `Intl` (`1,234.5` on `en`, `1.234,5` on `de`/`vi`). The counts go through `formatNumber` for the
 * same reason and not merely for a thousands separator: a locale on a non-Latin numbering system
 * would otherwise print the counts in one digit system and the hours in another, on one line.
 *
 * `roundPoints` in `split-draft.ts` is NOT redundant with this and must stay: it fixes the VALUE that
 * `delta === 0` compares — which is what selects the success token — whereas these helpers only fix
 * what is displayed.
 */
function SplitFooterSummary({
  preview,
  derived,
}: {
  preview: SplitPreview
  derived: SplitDerived
}) {
  const { t } = useTranslation('split-story')
  const totals = splitPreviewTotals(preview)

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle">
      <span>
        {t('footer.counts', {
          tasks: formatNumber(totals.tasks),
          defects: formatNumber(totals.defects),
          testCases: formatNumber(totals.testCases),
        })}
      </span>
      <span aria-hidden="true">|</span>
      <span>
        {t('footer.hours', {
          actual: formatPoints(totals.actualHours),
          todo: formatPoints(totals.todoHours),
        })}
      </span>
      <span aria-hidden="true">|</span>
      <span className={derived.delta === 0 ? 'text-success' : 'text-warning'}>
        {t('footer.points', {
          original: formatPoints(derived.originalPoints),
          combined: formatPoints(derived.combinedPoints),
          delta: formatDelta(derived.delta),
        })}
      </span>
    </div>
  )
}
