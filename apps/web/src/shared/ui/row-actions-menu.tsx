/**
 * `RowActionsMenu` — the mutation-agnostic shell behind `WorkItemRowActions` (Backlog/Quality/
 * Iteration Status) and `TestCaseRowActions` (the Test Cases tab, Phase F).
 *
 * `WorkItemRowActions` used to hardcode `useDeleteWorkItem`, so a second grid needing the SAME
 * shape — one kebab menu, one Delete item, a NAMED confirmation — would have meant a second copy
 * of the menu/dialog wiring (CLAUDE.md's own warning: "a second copy is how two grids come to
 * confirm differently"). This shell owns the menu/dialog/pending/error-toast plumbing; each caller
 * supplies only its own labels and its own `onDelete`.
 *
 * The confirmation is NAMED, not typed — every current caller's delete is SOFT and reversible in
 * the database, so the typed "type DELETE to confirm" gate (reserved for the irreversible) does
 * not apply. A future caller whose delete IS irreversible needs a different control, not a flag
 * added here.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { ActionMenu, ActionMenuItem } from '@/shared/ui/action-menu'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { notify } from '@/shared/lib/toast'

export function RowActionsMenu({
  menuLabel,
  deleteActionLabel,
  confirmTitle,
  confirmMessage,
  deletedMessage,
  failedMessage,
  canDelete,
  onDelete,
}: {
  /** Accessible name for the kebab trigger, e.g. "Actions for TC-3". */
  menuLabel: string
  deleteActionLabel: string
  confirmTitle: string
  confirmMessage: string
  deletedMessage: string
  failedMessage: string
  /** The menu renders NOTHING without this — an action that only refuses is noise, and the row
   *  already has no other verb. */
  canDelete: boolean
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)

  if (!canDelete) return null

  return (
    <>
      <ActionMenu ariaLabel={menuLabel}>
        <ActionMenuItem
          icon={<Trash2 size={13} />}
          label={deleteActionLabel}
          destructive
          onClick={() => setConfirm(true)}
        />
      </ActionMenu>
      <ConfirmDialog
        open={confirm}
        destructive
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={deleteActionLabel}
        pending={pending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setPending(true)
          void onDelete()
            .then(() => {
              setPending(false)
              setConfirm(false)
              notify.success(deletedMessage)
            })
            .catch((e: unknown) => {
              // The server's own sentence: a refusal here explains itself (another team's row, an
              // archived project), and a generic failure toast would hide which.
              setPending(false)
              setConfirm(false)
              notify.error(e instanceof Error ? e.message : failedMessage)
            })
        }}
      />
    </>
  )
}
