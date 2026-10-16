import { Layers } from 'lucide-react'

import { PriorityBadge } from '@/entities/work-item/ui/badges'
import { IdCell } from '@/entities/work-item/ui/id-cell'
import { StateStepper } from '@/entities/work-item/ui/state-stepper'
import { SCHEDULE_STATE_STEPS } from '@/entities/work-item/ui/state-steps'
import type { ScheduleState } from '@/entities/work-item/model/types'
import { PORTFOLIO_TYPE_CONFIG } from '@/entities/work-item/model/types'
import { BRAND } from '@/shared/config/brand'
import { entityDetailPath } from '@/shared/lib/entity-link'
import type { ListResource } from '@/shared/lib/query/resource'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { OwnerCell } from '@/shared/ui/owner-cell'
import { SkeletonList } from '@/shared/ui/skeleton'

/**
 * Shared read-only artifact table used by the milestone- and release-detail
 * pages. Both surfaces list linked work items with an identical column set, so
 * the table (header + rows + empty/loading states) lives here to stay DRY and
 * visually consistent. The item type is structural — any object exposing these
 * fields (e.g. `ArtifactItem`, `ReleaseArtifactItem`) satisfies it.
 */
export interface ArtifactTableItem {
  id: string
  itemKey: string
  type: string
  title: string
  scheduleState: string
  priority: string
  assigneeName?: string | null
  storyPoints: number | null
}

function ArtifactRow({
  item,
  index,
  onOpen,
}: {
  item: ArtifactTableItem
  index: number
  onOpen: () => void
}) {
  return (
    <tr
      className="border-b border-border-inner transition-colors duration-75"
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = BRAND.surfaceHover)}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      {/* Rank */}
      <td className="h-8 px-3 text-center font-mono text-ui-xs text-foreground-subtle tabular-nums">
        {index + 1}
      </td>
      {/* ID — type glyph + key link (the only nav affordance) */}
      <td className="h-8 px-3">
        <IdCell
          type={item.type}
          itemKey={item.itemKey}
          onOpen={onOpen}
          // A portfolio artifact is addressed by id; a work item gets its key-based default.
          href={
            item.type in PORTFOLIO_TYPE_CONFIG ? entityDetailPath.portfolioItem(item.id) : undefined
          }
        />
      </td>
      {/* Name */}
      <td className="h-8 px-3">
        <span className="block max-w-[300px] text-ui-md font-medium break-words whitespace-normal text-foreground">
          {item.title}
        </span>
      </td>
      {/* Schedule State */}
      <td className="h-8 px-3">
        <StateStepper
          steps={SCHEDULE_STATE_STEPS}
          value={item.scheduleState as ScheduleState}
          canEdit={false}
          ariaLabel="Schedule state"
        />
      </td>
      {/* Priority */}
      <td className="h-8 px-3">
        <PriorityBadge priority={item.priority} />
      </td>
      {/* Owner */}
      <td className="h-8 px-3">
        <OwnerCell name={item.assigneeName} />
      </td>
      {/* Estimate */}
      <td className="h-8 px-3 text-center font-mono text-ui-xs text-muted-foreground">
        {item.storyPoints ?? '--'}
      </td>
    </tr>
  )
}

export function ArtifactTable({
  artifacts,
  search,
  entityNoun,
  startIndex,
  onOpenItem,
}: {
  /**
   * The page's artifacts query, wrapped with `listResource(...)`.
   *
   * Was `items: ArtifactTableItem[]` + `isLoading`, with no way to say "the request failed" — so
   * both callers passed `data?.data ?? []` and the zero-row branch below printed
   * "No artifacts linked to this release" for EVERY record while one of the two endpoints was
   * 400ing on every request. Keep this a resource; an array prop cannot carry the difference.
   */
  artifacts: ListResource<ArtifactTableItem>
  search: string
  /** Noun used in the empty state, e.g. "milestone" or "release". */
  entityNoun: string
  /** Absolute index of the first row (page offset), for the # column. */
  startIndex: number
  onOpenItem: (item: ArtifactTableItem) => void
}) {
  const items = artifacts.rows

  if (artifacts.isLoading) return <SkeletonList rows={8} />

  // Error BEFORE empty. A 403/500 is not evidence that nothing is linked.
  if (artifacts.phase === 'error') return <LoadErrorState error={artifacts.error} size="sm" />

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
        <Layers size={32} className="text-foreground-faint" />
        <p className="text-ui-md text-foreground-subtle">
          {search ? 'No artifacts match your search' : `No artifacts linked to this ${entityNoun}`}
        </p>
      </div>
    )
  }

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-border-strong bg-surface-hover text-ui-xs font-semibold tracking-wider uppercase select-none">
          <th className="h-7 w-12 px-3 text-center font-medium text-foreground-subtle">#</th>
          <th className="h-7 w-24 px-3 font-medium text-foreground-subtle">ID</th>
          <th className="h-7 px-3 font-medium text-foreground-subtle">Name</th>
          <th className="h-7 w-32 px-3 font-medium text-foreground-subtle">Schedule State</th>
          <th className="h-7 w-16 px-3 font-medium text-foreground-subtle">Priority</th>
          <th className="h-7 w-28 px-3 font-medium text-foreground-subtle">Owner</th>
          <th className="h-7 w-14 px-3 text-center font-medium text-foreground-subtle">Est.</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, idx) => (
          <ArtifactRow
            key={item.id}
            item={item}
            index={startIndex + idx}
            onOpen={() => onOpenItem(item)}
          />
        ))}
      </tbody>
    </table>
  )
}
