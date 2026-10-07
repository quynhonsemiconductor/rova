import { PortfolioItemType } from '@/entities/work-item/model/types'
import { WorkItemRefCell } from '@/entities/work-item/ui/work-item-ref-cell'

interface FeatureCellProps {
  /** Parent feature key, e.g. `FE-1`. */
  featureKey: string
  /** Feature title; when present it is appended as `KEY: Title` (Rally parity). */
  featureTitle?: string | null
  /**
   * Open the feature (navigation is owned by the caller). ABSENT means the reader cannot open
   * Portfolio detail — §3.2:85 hides it from an Editor — so the cell renders as text.
   */
  onOpen?: () => void
  /** `/portfolio/{featureId}` — the Feature's detail URL, for opening it in a new tab (US-120). */
  href?: string
}

/**
 * Feature column cell — a purple feature glyph followed by `KEY: Title`. Thin
 * wrapper over the shared {@link WorkItemRefCell} so the Feature column renders
 * identically on Backlog, Iteration Status, and any future board.
 */
export function FeatureCell({ featureKey, featureTitle, onOpen, href }: FeatureCellProps) {
  return (
    <WorkItemRefCell
      type={PortfolioItemType.Feature}
      itemKey={featureKey}
      title={featureTitle}
      onOpen={onOpen}
      href={href}
    />
  )
}
