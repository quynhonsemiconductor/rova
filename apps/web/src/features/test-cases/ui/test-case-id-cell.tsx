/**
 * The Test Case ID column cell — a plain key link, no type glyph.
 *
 * `entities/work-item/ui/id-cell.tsx`'s `IdCell` is NOT reused here: it renders a `TypeBadge`
 * keyed on `WorkItemType`, and a Test Case has no such type concept to fake. Styled by the shared
 * `Button` (link variant) rather than hand-rolled classes — the FE consistency ratchet counts raw
 * button tags and may only ever decrease.
 *
 * Rendered `asChild` over a {@link RecordLink}, so the key is a real `<a href>` and opens in a new tab
 * on Ctrl/Cmd+click or middle-click (US-120); a plain click still calls `onOpen`.
 */
import { entityDetailPath } from '@/shared/lib/entity-link'
import { Button } from '@/shared/ui/button'
import { RecordLink } from '@/shared/ui/record-link'

export function TestCaseIdCell({
  testCaseKey,
  onOpen,
}: {
  testCaseKey: string
  onOpen: () => void
}) {
  return (
    <Button
      asChild
      variant="link"
      size="xs"
      className="min-w-0 justify-start p-0 font-mono text-ui-md"
    >
      <RecordLink href={entityDetailPath.testCase(testCaseKey)} onOpen={onOpen} title={testCaseKey}>
        {testCaseKey}
      </RecordLink>
    </Button>
  )
}
