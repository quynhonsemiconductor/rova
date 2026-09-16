/**
 * BulkSplitStory — the Iteration Status entry point (SU-01 AC2).
 *
 * Rendered inside the existing `BulkActionBar` via `SelectableTable`'s `bulkActions` slot, beside
 * `BulkDeleteCopy`, using the same `BulkBarButton` that bar already uses — a second button family in
 * one bar is the inconsistency `fe-consistency` exists to prevent.
 *
 * **Bulk Split is out of scope (SRS §16)**, so >1 selected disables the control rather than splitting
 * each row. That is the same shape as `Copy` beside it, which is also a single-row verb.
 *
 * THE ELIGIBILITY RULE IS THE SERVER'S, and the split of responsibility here matters:
 *
 *   • the CLIENT narrows — `selection.count === 1 && row.type === 'story'` — purely so a request that
 *     cannot succeed is never made. It can only ever ask FEWER questions than the server answers.
 *   • the SERVER decides — `eligible` from `GET /work-items/:id/split-preview`, which is the same
 *     answer, from the same code, that the detail-page kebab and SU-06's write path use.
 *
 * The inverse — a client that re-derived "finished state / has an iteration / has a valid later
 * target" — is the "picker narrower than the write" fault class in the plan risk register, with the
 * two halves in different languages.
 *
 * `ineligibleReason` is never rendered. The tooltip says only that the story cannot be split, which
 * is what SRS §11 allows: disabled, with no explanation of which rule refused.
 */
import { useState } from 'react'
import { Scissors } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BulkBarButton } from '@/shared/ui/bulk-action-bar'
import { valueResource } from '@/shared/lib/query/resource'
import { useSplitPreview } from '@/features/work-items/api'
import { SplitStoryModal } from '@/features/work-items/ui/split-story-modal'
import type { RowSelection } from '@/shared/lib/hooks/use-row-selection'

/** The columns of a selectable row this control needs. Structural, so any grid row satisfies it. */
export interface SplitSelectableRow {
  id: string
  itemKey: string
  title: string
  type: string
}

export function BulkSplitStory({
  selection,
  rows,
}: {
  selection: RowSelection
  /** The grid's rows, so the single selected one can be resolved to its type and title. */
  rows: readonly SplitSelectableRow[]
}) {
  const { t } = useTranslation('split-story')
  const [open, setOpen] = useState(false)

  const selected =
    selection.count === 1 ? (rows.find((row) => selection.selectedIds.has(row.id)) ?? null) : null
  const isStory = selected?.type === 'story'

  // Bound to its own const before `valueResource` — see `resource.ts` on the React Compiler.
  const previewQuery = useSplitPreview(selected?.id, { enabled: isStory })
  const preview = valueResource(previewQuery)

  // BOTH halves are required, and the client half is not redundant: `enabled: false` stops a query
  // from FETCHING but TanStack still serves whatever is already cached for that key — so after one
  // eligible Story has been previewed, selecting a Defect (or a second row) would otherwise read a
  // warm `eligible: true` and offer the verb. Caught by `bulk-split-story.test.tsx`.
  //
  // `eligible === true` and nothing looser. In flight, after a failure, and for a non-Story the
  // answer is the same — the control stays disabled — because an optimistic default would offer a
  // verb the server refuses.
  const eligible = selection.count === 1 && isStory && preview.value?.eligible === true

  return (
    <>
      <BulkBarButton
        icon={<Scissors size={13} />}
        label={t('action.bulkLabel')}
        disabled={!eligible}
        // Only while DISABLED — an enabled button whose tooltip says it cannot be used is worse than
        // no tooltip. Which of the two sentences applies is the ONE distinction allowed: "pick a
        // single story" is about the SELECTION and is actionable by the reader. Once the selection is
        // right and the server still says no, SRS §11 forbids explaining which rule refused.
        title={
          eligible
            ? undefined
            : selection.count === 1 && isStory
              ? t('action.disabledNotEligible')
              : t('action.disabledOneStory')
        }
        onClick={() => setOpen(true)}
      />
      {open && selected && (
        <SplitStoryModal
          open={open}
          onClose={() => setOpen(false)}
          workItemId={selected.id}
          itemKey={selected.itemKey}
          title={selected.title}
        />
      )}
    </>
  )
}
