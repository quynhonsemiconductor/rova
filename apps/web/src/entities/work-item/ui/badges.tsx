import { BRAND } from '@/shared/config/brand'
import {
  BADGE_FALLBACK,
  DEFECT_SEVERITY_CONFIG,
  SCHEDULE_STATE_CONFIG,
  SCHEDULE_STATE_LABEL,
  WORK_ITEM_PRIORITY_CONFIG,
  WORK_ITEM_TYPE_CONFIG,
  TIMEBOX_TYPE_CONFIG,
  PORTFOLIO_TYPE_CONFIG,
  type DefectSeverity,
  type PortfolioItemType,
  type ScheduleState,
  type WorkItemPriority,
  type WorkItemType,
} from '@/entities/work-item/model/types'

// ── TypeBadge ─────────────────────────────────────────────────────────────────

interface TypeBadgeProps {
  type: WorkItemType | string
  /** Chip diameter in px (default 18 — the Rally grid size). */
  size?: number
}

export function TypeBadge({ type, size = 18 }: TypeBadgeProps) {
  const cfg = WORK_ITEM_TYPE_CONFIG[type as WorkItemType] ??
    PORTFOLIO_TYPE_CONFIG[type as PortfolioItemType] ??
    TIMEBOX_TYPE_CONFIG[type] ?? {
      label: type.slice(0, 2).toUpperCase(),
      ...BADGE_FALLBACK,
    }
  const Icon = cfg.icon
  // parity with Broadcom Rally: a circular, solid-colour chip with a white glyph.
  // Single source for the work-item type mark — reused by IdCell,
  // WorkItemRefCell, the detail header and every grid's ID column, so the type
  // icon can never drift between pages.
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-card"
      style={{ width: size, height: size, backgroundColor: cfg.color }}
      title={cfg.label}
    >
      {Icon ? (
        <Icon size={Math.round(size * 0.58)} strokeWidth={2.4} />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.44), fontWeight: 700 }}>{cfg.label}</span>
      )}
    </span>
  )
}

// ── StatusBadge (Schedule State) ──────────────────────────────────────────────

interface ScheduleStateBadgeProps {
  state: ScheduleState | string
}

export function ScheduleStateBadge({ state }: ScheduleStateBadgeProps) {
  const cfg = SCHEDULE_STATE_CONFIG[state as ScheduleState] ?? BADGE_FALLBACK
  const label = SCHEDULE_STATE_LABEL[state as ScheduleState] ?? state
  return (
    <span
      className="inline-flex h-5 items-center rounded-sm px-1.5 text-ui-xs font-medium"
      style={{ color: cfg.color, backgroundColor: cfg.bg }}
    >
      {label}
    </span>
  )
}

// ── SeverityBadge (defect severity) ───────────────────────────────────────────

interface SeverityBadgeProps {
  severity: DefectSeverity | string | null | undefined
}

/** Read-only defect severity pill (SRS labels + colour). Renders `—` for none. */
export function SeverityBadge({ severity }: SeverityBadgeProps) {
  if (!severity || severity === 'none') {
    return <span className="text-ui-xs text-foreground-faint">--</span>
  }
  const cfg = DEFECT_SEVERITY_CONFIG[severity as DefectSeverity] ?? DEFECT_SEVERITY_CONFIG.none
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-px text-ui-xs font-medium"
      style={{ backgroundColor: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}
    >
      {cfg.label}
    </span>
  )
}

// ── PriorityBadge ─────────────────────────────────────────────────────────────

interface PriorityBadgeProps {
  priority: WorkItemPriority | string
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  const cfg = WORK_ITEM_PRIORITY_CONFIG[priority as WorkItemPriority] ?? {
    label: priority,
    color: BRAND.textSecondary,
  }
  return (
    <span className="text-ui-xs font-medium" style={{ color: cfg.color }}>
      {cfg.label}
    </span>
  )
}
