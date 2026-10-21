import { PortfolioItemType, WorkItemType } from '@/entities/work-item/model/types'
import { entityDetailPath } from '@/shared/lib/entity-link'

type AddressedType = WorkItemType | PortfolioItemType

// The two enums must not share a VALUE: the map below is keyed by value, so a shared one would
// collapse two entries into one with no error and flip a record kind to the wrong scheme. A shared
// value makes `Extract<…>` non-`never`, and this line then fails to compile.
const enumsAreDisjoint: [Extract<WorkItemType, PortfolioItemType>] extends [never] ? true : never =
  true
void enumsAreDisjoint

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

// The map's keys as a Set, so membership is a lookup that cannot hit an inherited name
// (`constructor` — `Object.keys` returns own keys only) without probing the map with
// `Object.hasOwn` (ES2022), a runtime method Vite's default build target does not guarantee.
const ADDRESSED_TYPES: ReadonlySet<string> = new Set(Object.keys(ADDRESSING))

function isAddressedType(type: string): type is AddressedType {
  return ADDRESSED_TYPES.has(type)
}

/**
 * The detail path an ID / reference cell can derive on its own (US-120) — the one place the
 * TYPE → id-or-key choice lives, so a grid mixing artifact kinds passes `recordId` unconditionally
 * instead of re-implementing the split. The path strings come from `entityDetailPath`, which
 * `entityLinkFor` also uses — but `entityLinkFor` makes no type → id-or-key choice of its own: its
 * callers name the route kind outright (capacity plan, iteration, milestone, release), none of them
 * a work item or portfolio item.
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
    // No key yet (an optimistic row) means no URL — never a bare `/item/`. The same rule
    // `entityLinkFor` applies (`!key` → `undefined`). A cell that renders such a row and LATER gets
    // its key flips <button> → <a>: see the first-render note on `RecordOpener`.
    return itemKey ? entityDetailPath.workItem(itemKey) : undefined
  }
  return recordId ? entityDetailPath.portfolioItem(recordId) : undefined
}

/**
 * The URL a cell renders: its explicit `href`, else the derived one. `||`, not `??`: an empty
 * `href` is no URL, and must not become `<a href="">` (the current page). Both ID and reference
 * cells call this, so the rule has one copy.
 */
export function resolveRecordHref(
  href: string | undefined,
  type: string,
  itemKey: string,
  recordId?: string,
): string | undefined {
  return href || defaultRecordHref(type, itemKey, recordId)
}
