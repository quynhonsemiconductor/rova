/**
 * SaveCancelBar — floating action bar shown at the bottom of a detail page
 * when there are unsaved edits, matching Broadcom's Rally UX: fields don't
 * auto-save on every change, they accumulate locally until the user commits
 * (Save) or discards (Cancel) them.
 */
import { Loader2 } from 'lucide-react'
import { Button } from './button'

export function SaveCancelBar({
  visible,
  saving,
  errorMsg,
  onSave,
  onCancel,
}: {
  visible: boolean
  saving: boolean
  errorMsg?: string | null
  onSave: () => void
  onCancel: () => void
}) {
  if (!visible) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center pb-5"
      role="region"
      aria-label="Unsaved changes"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border-strong bg-card px-4 py-2.5 shadow-lg">
        <span className="text-ui-sm font-medium text-foreground">
          {errorMsg ? (
            <span className="text-destructive">{errorMsg}</span>
          ) : (
            'You have unsaved changes'
          )}
        </span>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving && <Loader2 size={12} className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  )
}
