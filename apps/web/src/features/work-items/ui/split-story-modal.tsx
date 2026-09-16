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
 */
import { useTranslation } from 'react-i18next'

import { AppModal, ModalBody, ModalFooter } from '@/shared/ui/app-modal'
import { Button } from '@/shared/ui/button'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { valueResource } from '@/shared/lib/query/resource'
import { useSplitPreview } from '@/features/work-items/api'

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
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section aria-labelledby="split-panel-unfinished" className="space-y-2">
              <h3 id="split-panel-unfinished" className="text-ui-sm font-semibold text-foreground">
                {preview.value?.story.iterationName
                  ? t('panels.unfinished', { iteration: preview.value.story.iterationName })
                  : t('panels.unfinishedNoIteration')}
              </h3>
            </section>
            <section aria-labelledby="split-panel-continued" className="space-y-2">
              <h3 id="split-panel-continued" className="text-ui-sm font-semibold text-foreground">
                {t('panels.continued')}
              </h3>
            </section>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
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
      </ModalFooter>
    </AppModal>
  )
}
