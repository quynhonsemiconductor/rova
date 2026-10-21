import { PortfolioItemType, WorkItemType } from '@/entities/work-item/model/types'
import { entityDetailPath } from '@/shared/lib/entity-link'

type AddressedType = WorkItemType | PortfolioItemType

/**
 * How each record kind is addressed. A `Record` over BOTH enums, so a member added to either enum
 * is a COMPILE error here until someone decides how it is addressed — it cannot fall through to
 * "no URL" silently — and a mistyped key is refused too.
 */
const ADDRESSING: Record<AddressedType, 'key' | 'id'> = {
  [WorkItemType.Story]: 'key',
  [WorkItemType.Task]: 'key',
  [WorkItemType.Defect]: 'key',
  [PortfolioItemType.Epic]: 'id',
  [PortfolioItemType.Feature]: 'id',
}

function isAddressedType(type: string): type is AddressedType {
  return Object.hasOwn(ADDRESSING, type)
}

/**
 * The detail path an ID / reference cell can derive on its own (US-120) — the ONE place the
 * id-vs-key addressing rule lives, so a grid mixing artifact kinds passes `recordId` unconditionally
 * instead of re-implementing the split.
 *
 * A Story / Task / Defect is addressed by its KEY (`/item/US-5`). An Epic / Feature is addressed by
 * its own id (`/portfolio/<id>`), so it needs `recordId`. Timeboxes, projects and capacity plans
 * are not derivable from a type and return `undefined` — the caller passes `href` itself.
 */
export function defaultRecordHref(
  type: string,
  itemKey: string,
  recordId?: string,
): string | undefined {
  if (!isAddressedType(type)) return undefined
  if (ADDRESSING[type] === 'key') {
    // No key yet (an optimistic row) means no URL — never a bare `/item/` (as `entityLinkFor` does).
    return itemKey ? entityDetailPath.workItem(itemKey) : undefined
  }
  return recordId ? entityDetailPath.portfolioItem(recordId) : undefined
}
