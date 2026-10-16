import { WorkItemType } from '@/entities/work-item/model/types'
import { entityDetailPath } from '@/shared/lib/entity-link'

const WORK_ITEM_TYPES: ReadonlySet<string> = new Set(Object.values(WorkItemType))

/**
 * The detail path an ID / reference cell can derive on its own (US-120).
 *
 * Only a Story / Task / Defect is addressed by its KEY (`/item/US-5`). Portfolio items, timeboxes,
 * projects and capacity plans are addressed by their own id, which a cell rendering a key does not
 * hold — so those return `undefined` and the caller passes `href` itself.
 */
export function defaultRecordHref(type: string, itemKey: string): string | undefined {
  return WORK_ITEM_TYPES.has(type) ? entityDetailPath.workItem(itemKey) : undefined
}
