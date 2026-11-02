/**
 * WorkItemActionsMenu — the "More work item actions" kebab in the Work Item detail header.
 *
 * **This menu did not exist before SU-01.** The header carries individual `DetailHeaderButton`s
 * (watcher count, Watch/Unwatch, Delete); the SRS names the kebab literally, so this PR creates it
 * and puts `Split unfinished story` in it. It moves NOTHING else in — relocating Watch or Delete
 * would be a change to two shipped, tested affordances that no AC asks for.
 *
 * `onDark` because `DetailLayout`'s header is the dark bar: `ActionMenu`'s default trigger is
 * `text-muted-foreground`, which is invisible there.
 *
 * ELIGIBILITY IS THE SERVER'S. Two facts the page already holds — the row is a Story, and the caller
 * holds `work_item:edit` — decide whether the kebab renders at all. Whether the item is ENABLED is the
 * server's `eligible` from the split preview, the same answer the Iteration Status entry point reads:
 * SU-01 AC4–AC6 require the action itself to be disabled for an Accepted, unscheduled or
 * target-less Story, with no explanatory message (BA retest TC-39 — it used to open the modal and
 * refuse there). `eligible === true` and nothing looser, so it stays disabled while in flight.
 *
 * Absent rather than disabled without `work_item:edit`, matching Delete beside it: "the verb is
 * either granted or it is not, and a control that only refuses is noise" (`CLAUDE.md`). The kebab
 * itself is absent when it would hold nothing — a menu with no items is a control that opens onto an
 * explanation of its own uselessness.
 */
import { useState } from 'react'
import { Scissors } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ActionMenu, ActionMenuItem } from '@/shared/ui/action-menu'
import { valueResource } from '@/shared/lib/query/resource'
import { useSplitPreview } from '@/features/work-items/api'
import { SplitStoryModal } from '@/features/work-items/ui/split-story-modal'

export function WorkItemActionsMenu({
  workItemId,
  itemKey,
  title,
  type,
  canEdit,
}: {
  workItemId: string
  itemKey: string
  title: string
  /** Only a Story is splittable (BR-01). A Task or Defect header renders no kebab at all. */
  type: string
  /** `work_item:edit` on this item's project — the code SU-06's write path will require. */
  canEdit: boolean
}) {
  const { t } = useTranslation('split-story')
  const [splitOpen, setSplitOpen] = useState(false)
  const splittable = type === 'story' && canEdit

  // Bound to its own const before `valueResource` — see `resource.ts` on the React Compiler.
  const previewQuery = useSplitPreview(workItemId, { enabled: splittable })
  const preview = valueResource(previewQuery)
  const eligible = splittable && preview.value?.eligible === true

  // The menu holds exactly one verb today, so "may not split" and "menu is empty" are the same
  // state. Render nothing rather than an empty popover.
  if (!splittable) return null

  return (
    <>
      <ActionMenu ariaLabel={t('action.menuLabel')} onDark>
        <ActionMenuItem
          icon={<Scissors size={13} />}
          label={t('action.label')}
          disabled={!eligible}
          onClick={() => setSplitOpen(true)}
        />
      </ActionMenu>
      {/*
        Mounted only while open. The preview is a live read of eligibility — schedule state and
        Iteration can both change on this very page — so keeping a closed modal mounted would either
        hold a stale answer or fetch one nobody asked for.
      */}
      {splitOpen && (
        <SplitStoryModal
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          workItemId={workItemId}
          itemKey={itemKey}
          title={title}
        />
      )}
    </>
  )
}
