import { useTranslation } from 'react-i18next'
import { Check, Trophy, Star, Users } from 'lucide-react'

import { Tooltip } from '@/shared/ui/tooltip'

import { BRAND } from '@/shared/config/brand'
import { type EstimateTier } from '@/features/capacity-planning/api'

/**
 * Which tier a Feature's Estimated figure came from.
 *
 * Worth surfacing because the same number means different things: an ALLOCATED value is a
 * commitment a planner typed, a REFINED one is a top-down forecast, and a PRELIMINARY one is
 * only a T-shirt size mapped through workspace settings. Without the badge a planner cannot
 * tell which of their numbers are real commitments and which are placeholders that will move.
 *
 * Order of precedence is Allocated → Refined → Preliminary → none, resolved server-side by
 * `resolveEstimate` so the badge and the arithmetic can never disagree.
 */
const TIER_STYLE: Record<EstimateTier, { color: string; bg: string }> = {
  // A real commitment — the strongest signal.
  allocated: { color: BRAND.primary, bg: BRAND.primaryLighter },
  refined: { color: BRAND.textSecondary, bg: BRAND.surfaceHover },
  // Only a T-shirt size: deliberately the quietest, since it is the least reliable.
  preliminary: { color: BRAND.textMuted, bg: BRAND.surfaceSubtle },
  none: { color: BRAND.textMuted, bg: 'transparent' },
}

export function EstimateTierBadge({ tier }: { tier: EstimateTier }) {
  const { t } = useTranslation('capacity')
  // Nothing to say when there is no estimate at all — an empty badge would be noise.
  if (tier === 'none') return null

  const style = TIER_STYLE[tier]
  return (
    <span
      className="shrink-0 rounded px-1 text-ui-xs font-semibold uppercase"
      style={{ color: style.color, backgroundColor: style.bg }}
      title={t(`tiers.${tier}Hint`)}
    >
      {t(`tiers.${tier}`)}
    </span>
  )
}

/**
 * Rally's trailing `Estimate` control: one glyph, and on hover a panel naming ALL THREE candidate
 * estimates with the one in force ticked.
 *
 *     Estimate
 *     👤 Allocated    60   ✓
 *     ★  Refined      —
 *     🏆 Preliminary  250
 *
 * The panel is the point, not the glyph. The same number means different things — an allocated value
 * is a commitment a planner typed, a refined one a top-down forecast, a preliminary one a T-shirt
 * size mapped through settings — and the question a planner actually has is "is this 60 real, or is
 * it a placeholder that will move?". Only showing the losers answers it.
 *
 * Glyphs follow Rally: a person for allocated (someone committed it), a star for refined, a trophy
 * for preliminary. Colours come from `TIER_STYLE`, shared with {@link EstimateTierBadge}, so the two
 * renderings of one fact cannot drift.
 */
const TIER_ICON = { allocated: Users, refined: Star, preliminary: Trophy } as const

export interface EstimateBreakdown {
  allocated: number | null
  refined: number | null
  preliminary: number | null
}

/**
 * Rally's own placeholder inside this panel is an EM DASH, not the app's `--`.
 *
 * The app unified on `--` for absent values and this is the one deliberate exception: the panel is a
 * replica of a vendor screenshot, matched row for row, and the dash is part of what is being matched. It
 * is a fixed label in one tooltip rather than a data cell, so it does not reopen the placeholder rule —
 * do not "fix" it back.
 */
const RALLY_ABSENT = '—' // legacy identifier, do not rename

export function EstimateTierIcon({
  tier,
  breakdown,
  sourceNote,
}: {
  tier: EstimateTier
  /** All three candidates. Omit to render the glyph alone (no panel to show). */
  breakdown?: EstimateBreakdown
  /**
   * How the row's stored value was produced (`Manual` / `Feature Estimate`), for the accessible name.
   *
   * Not rendered in the panel: Rally's has exactly three rows and a heading, and §185-186's source is a
   * finer distinction than Rally draws. It still has to be reachable, so it goes into the glyph's name.
   */
  sourceNote?: string
}) {
  const { t } = useTranslation('capacity')
  if (tier === 'none') return null

  const Icon = TIER_ICON[tier]
  const style = TIER_STYLE[tier]
  /**
   * A FORECAST of zero reads as the em dash, a committed zero reads as `0`.
   *
   * `refined_estimate` is NOT NULL DEFAULT 0 and `no_entry` maps to 0 points, and 0 is the "not
   * forecast" value throughout the domain — `resolveEstimate` and `forecastTarget` both require `> 0`,
   * so a zero candidate can never win. Printing `Refined 0` would offer a candidate that is not one;
   * Rally's screenshot shows `—` in exactly that row.
   *
   * `allocated` is different: a row committing 0 is a real commitment (§246's Team-picker default), so
   * it prints 0 and keeps its tick.
   */
  const rows = (['allocated', 'refined', 'preliminary'] as const).map((key) => {
    const raw = breakdown?.[key] ?? null
    return {
      key,
      value: key === 'allocated' ? raw : raw === null || raw === 0 ? null : raw,
      RowIcon: TIER_ICON[key],
      inForce: key === tier,
    }
  })
  // The accessible name says what the panel says: a hover-only tooltip is invisible to a screen
  // reader, and the tier is the fact the row is reporting. FULL tier names, not the badge's
  // 5-character abbreviations — this string is read aloud, and "Alloc" is not a word.
  const label = rows
    .map((r) => `${t(`tiers.${r.key}Full`)} ${r.value ?? RALLY_ABSENT}${r.inForce ? ' ✓' : ''}`)
    .join(', ')

  const glyph = (
    <span
      role="img"
      aria-label={`${t('tiers.heading')}: ${label}${sourceNote ? `. ${sourceNote}` : ''}`}
      className="flex items-center"
    >
      <Icon size={13} style={{ color: style.color }} />
    </span>
  )
  if (breakdown === undefined) return glyph

  return (
    // The shared `Tooltip`, which PORTALS: a panel rendered inline was clipped by the nested
    // table's scroll container, so the bottom two tiers were cut off — exactly the rows the
    // tooltip exists to show.
    <Tooltip
      side="left"
      delayDuration={150}
      content={
        <span className="block w-44">
          <span className="mb-1 block font-semibold">{t('tiers.heading')}</span>
          {rows.map(({ key, value, RowIcon, inForce }) => (
            <span key={key} className="flex items-center gap-1.5 py-px">
              {/* The losing tiers are STRUCK THROUGH, not merely dimmed — that is what Rally draws, and
                  it says something dimming does not: this candidate was considered and beaten. Both the
                  name and the number carry the line, as in the screenshot. Shown rather than hidden
                  because the comparison IS the point: a planner asking "is this 10 real?" needs to see
                  what it beat. */}
              <RowIcon size={11} className={inForce ? '' : 'opacity-50'} />
              <span className={inForce ? 'flex-1' : 'flex-1 line-through opacity-50'}>
                {t(`tiers.${key}Full`)}
              </span>
              <span className={inForce ? 'tabular-nums' : 'tabular-nums line-through opacity-50'}>
                {value ?? RALLY_ABSENT}
              </span>
              {/* Rally's tick: a white check in a FILLED green disc, not a bare green glyph. The disc is
                  what makes it read as a chosen state at 11px rather than as decoration. A spacer keeps
                  the three value columns aligned when it is absent. */}
              {inForce ? (
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: BRAND.success }}
                >
                  {/* `text-white` rather than a hex: lucide inherits `currentColor`, and the design-token
                      ratchet counts raw hex literals. */}
                  <Check size={9} strokeWidth={3} className="text-white" />
                </span>
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" />
              )}
            </span>
          ))}
        </span>
      }
    >
      {glyph}
    </Tooltip>
  )
}
