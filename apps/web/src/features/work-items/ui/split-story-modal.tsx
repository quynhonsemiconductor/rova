/**
 * SplitStoryModal — the shell, from SU-01.
 *
 * WHAT THIS PR DELIVERS, and deliberately no more (§8 Q14, D13): the modal opens with its title and
 * its two panel headings, closes by Cancel / `×` / Escape, and renders `Split story` **DISABLED with
 * a `title` tooltip**. There is NO write path anywhere in this PR — it lands whole in SU-06, at which
 * point the tooltip and the `disabled` come off together. The repo has shipped this exact shape
 * before: Phase A rendered `Add New` disabled-with-a-tooltip so the AC "the action is displayed" was
 * met without a dead control.
 *
 * SU-02 fills the panels (fields, read-only lines, validation), SU-03/04/05 add the three
 * collections, SU-06 enables the confirm. The two headings here are the seam those PRs build on.
 *
 * BUILT ON THE SHARED SHELL, not the mockup's `fixed inset-0` div: `AppModal` supplies the focus
 * trap, Escape-to-close, body scroll lock, `role="dialog"` + `aria-labelledby`, and the `maxHeight`
 * that makes `ModalBody` actually scroll instead of pushing the footer off-screen.
 *
 * WHAT IS DELIBERATELY ABSENT — assert the absences, they are the part most likely to regress
 * because adding a helpful message feels like an improvement (SRS §11):
 *   • `ineligibleReason` is NEVER rendered. The server sends it for telemetry and tests; every AC
 *     says the action is simply unavailable, with no explanation.
 *   • no toast, no validation text, no warning styling.
 *
 * ── SU-02 (2.1–2.6) ───────────────────────────────────────────────────────────
 * The panels now have their FIELDS, from one `useReducer` over `model/split-draft.ts`, plus the
 * footer's point comparison. Still nothing is saved: `Split story` remains unconditionally DISABLED
 * with its tooltip (§8 Q14), and `canConfirm` — already computed on the derived draft, already
 * accounting for eligibility, the chosen target and both validity rules — is deliberately NOT wired
 * to it. SU-06 plugs the button into `derived.canConfirm` and drops the `disabled` + `title` pair
 * together. The three collections (Tasks / Defects / Test Cases) are SU-03/04/05.
 */
import { useEffect, useReducer } from 'react'
import { useTranslation } from 'react-i18next'

import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { valueResource } from '@/shared/lib/query/resource'
import { useSplitPreview } from '@/features/work-items/api'
import type { SplitPreview } from '@/features/work-items/api'
import {
  deriveSplitDraft,
  splitDraftReducer,
  splitPreviewTotals,
  type SplitDerived,
} from '@/features/work-items/model/split-draft'
import { SplitStoryPanel } from '@/features/work-items/ui/split-story-panel'

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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section aria-labelledby="split-panel-unfinished" className="space-y-2">
              <h3 id="split-panel-unfinished" className="text-ui-sm font-semibold text-foreground">
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
        ) : null}
      </ModalBody>
      <ModalFooter className="justify-between">
        {derived && previewValue ? (
          <SplitFooterSummary preview={previewValue} derived={derived} />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('modal.cancel')}
          </Button>
          {/*
            RENDERED, and DISABLED. Not hidden: the AC is that the action is displayed, and a control
            that appears only once the feature is finished tells the reader nothing about what this
            screen is for. The `title` is the affordance a disabled button needs to explain itself —
            the same reason `BulkBarButton` grew one.
          */}
          <Button disabled title={t('modal.confirmDisabled')}>
            {t('modal.confirm')}
          </Button>
        </div>
      </ModalFooter>
    </AppModal>
  )
}

/** `+3` / `-2` / `0` — the sign is the whole point of the comparison (BR-13). */
function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}

/**
 * The footer summary (2.5) — what the split is carrying, and what it does to the points.
 *
 * NON-BLOCKING, and that is a business rule, not a style choice: BR-13/AC7 say the reader may split
 * 5 points into 3 + 4 and save it. So the token shifts (success when the sides still add up to the
 * original, warning when they do not) and NOTHING else changes — the delta reaches no `disabled` and
 * no message. Tokens, never raw hex.
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
          tasks: totals.tasks,
          defects: totals.defects,
          testCases: totals.testCases,
        })}
      </span>
      <span aria-hidden="true">|</span>
      <span>{t('footer.hours', { actual: totals.actualHours, todo: totals.todoHours })}</span>
      <span aria-hidden="true">|</span>
      <span className={derived.delta === 0 ? 'text-success' : 'text-warning'}>
        {t('footer.points', {
          original: derived.originalPoints,
          combined: derived.combinedPoints,
          delta: formatDelta(derived.delta),
        })}
      </span>
    </div>
  )
}
