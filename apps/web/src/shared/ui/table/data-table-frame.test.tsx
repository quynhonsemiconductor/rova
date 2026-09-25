/**
 * DataTableFrame — the scroll region must not shrink its rows (DE-21).
 *
 * The region is a COLUMN flex container with a definite height, so its children are flex items and
 * the default `flex-shrink: 1` applies to their HEIGHT. Once the rows overflow, the browser squeezes
 * every one of them down to the floor `TableRow` declares (`min-h-[35px]`) — so a row whose Name
 * wrapped to two or three lines kept the text's height while the row kept 35px, and the surplus
 * painted over the row above and was cut off below.
 *
 * jsdom does no layout, so there is nothing here to measure: `getBoundingClientRect` is 0×0 for
 * every element and a height assertion would pass with the bug in place. What CAN be asserted is the
 * rule that governs it, on the element that governs it — which is why this reads as a class ratchet
 * rather than a behavioural test. The behaviour itself is a browser fact, verified in a browser; this
 * stops the rule being deleted by someone rewriting the frame's chrome.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import { DataTableFrame } from './data-table-frame'
import { TableRow } from './table-row'

const HEADER = {
  columns: [{ key: 'name' as const, label: 'Name' }],
  colStyles: { name: { width: 200 } },
  onResize: () => {},
}

describe('DataTableFrame', () => {
  it('stops every direct child of the scroll region from shrinking', () => {
    const { container } = render(
      <DataTableFrame header={HEADER}>
        <TableRow>
          <div>A name long enough to wrap onto a second line in a narrow column</div>
        </TableRow>
      </DataTableFrame>,
    )

    const scrollRegion = container.querySelector('.overflow-auto')
    expect(scrollRegion).not.toBeNull()
    // The rows, the sticky header and the totals bar are all direct children of this one element.
    expect(scrollRegion?.className).toContain('[&>*]:shrink-0')
  })

  it('keeps the row height a FLOOR, not a fixed height, so a wrapped cell can grow the row', () => {
    const { container } = render(
      <DataTableFrame header={HEADER}>
        <TableRow>
          <div>Two lines</div>
        </TableRow>
      </DataTableFrame>,
    )

    const row = container.querySelector('.border-b.border-border-inner.text-ui-md')
    expect(row?.className).toContain('min-h-[35px]')
    // A fixed height would clip or overlap exactly the way the shrink did.
    expect(row?.className).not.toMatch(/(^|\s)h-\[/)
  })
})
