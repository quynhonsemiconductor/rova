/**
 * The Test Case ID column cell — a plain key link, no type glyph.
 *
 * `entities/work-item/ui/id-cell.tsx`'s `IdCell` is NOT reused here: it renders a `TypeBadge`
 * keyed on `WorkItemType`, and a Test Case has no such type concept to fake. Styled with the shared
 * `Button`'s link variant (`buttonVariants`) rather than hand-rolled classes.
 *
 * Rendered by {@link RecordOpener} DIRECTLY, not through `Button asChild`: Radix `Slot` hands its
 * child a `ref` and extra props, and `RecordOpener` takes neither, so the composition only worked by
 * accident. The key is a real `<a href>` that opens in a new tab on Ctrl/Cmd+click or middle-click
 * (US-120); a plain click still calls `onOpen`.
 */
import { entityDetailPath } from '@/shared/lib/entity-link'
import { buttonVariants } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { RecordOpener } from '@/shared/ui/record-link'

export function TestCaseIdCell({
  testCaseKey,
  onOpen,
}: {
  testCaseKey: string
  onOpen: () => void
}) {
  return (
    // No key yet (an optimistic row) → no URL, the same rule `defaultRecordHref` applies.
    <RecordOpener
      href={testCaseKey ? entityDetailPath.testCase(testCaseKey) : undefined}
      onOpen={onOpen}
      title={testCaseKey}
      className={cn(
        buttonVariants({ variant: 'link', size: 'xs' }),
        'min-w-0 justify-start p-0 font-mono text-ui-md',
      )}
    >
      {testCaseKey}
    </RecordOpener>
  )
}
