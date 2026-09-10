/**
 * The Test Case ID column cell — a plain key link, no type glyph.
 *
 * `entities/work-item/ui/id-cell.tsx`'s `IdCell` is NOT reused here: it renders a `TypeBadge`
 * keyed on `WorkItemType`, and a Test Case has no such type concept to fake. Uses the shared
 * `Button` (link variant) rather than a hand-rolled button element — the FE consistency ratchet
 * counts raw button tags and may only ever decrease.
 */
import { Button } from '@/shared/ui/button'

export function TestCaseIdCell({
  testCaseKey,
  onOpen,
}: {
  testCaseKey: string
  onOpen: () => void
}) {
  return (
    <Button
      variant="link"
      size="xs"
      className="min-w-0 justify-start p-0 font-mono text-ui-md"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      title={testCaseKey}
    >
      {testCaseKey}
    </Button>
  )
}
