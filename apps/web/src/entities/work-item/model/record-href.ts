import { PortfolioItemType, WorkItemType } from '@/entities/work-item/model/types'
import { entityDetailPath } from '@/shared/lib/entity-link'

// Listed, not derived from the enums: the contract is these exact types, and a member added to
// either enum later must not be admitted (and addressed the wrong way) silently.
const KEY_ADDRESSED_TYPES: ReadonlySet<string> = new Set<string>([
  WorkItemType.Story,
  WorkItemType.Task,
  WorkItemType.Defect,
])
const ID_ADDRESSED_PORTFOLIO_TYPES: ReadonlySet<string> = new Set<string>([
  PortfolioItemType.Epic,
  PortfolioItemType.Feature,
])

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
  if (KEY_ADDRESSED_TYPES.has(type)) return entityDetailPath.workItem(itemKey)
  if (recordId && ID_ADDRESSED_PORTFOLIO_TYPES.has(type)) {
    return entityDetailPath.portfolioItem(recordId)
  }
  return undefined
}
