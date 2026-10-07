/**
 * Reports — a `Type` selector beside the title and exactly one report rendered.
 *
 * Three types, no more: Iteration Burndown, Velocity, Team Capacity. The previous page was a
 * twelve-widget dashboard (status pie, workload, defect summary, blocked items, activity feed,
 * release progress…), every one of which duplicated a page that owns it — Iteration Status,
 * Quality, Releases, Notifications, Home — and none of which the approved Phase 6 contract
 * includes. Two definitions of "burndown" in one product is how they drift.
 *
 * Project and Team come from the global workspace context and nothing here adds a second
 * filter; the SRS forbids it. Each report owns only the control it genuinely needs — an
 * Iteration picker for the two that show one timebox, a window selector for the one that
 * compares several.
 *
 * Release Tracking is NOT here. It is its own page under `Portfolio > Release Tracking`.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { CompactSelect } from '@/shared/ui/native-select'
import { PageHeader } from '@/shared/ui/page-header'
import { EmptyState } from '@/shared/ui/empty-state'

import { CarryoverReport } from './ui/carryover-report'
import { IterationBurndownReport } from './ui/iteration-burndown-report'
import { TeamCapacityReport } from './ui/team-capacity-report'
import { VelocityReport } from './ui/velocity-report'
import type { CarryoverDirection } from '@/features/reporting/api'
import { rememberIteration } from './model/use-selected-iteration'

// Phase 7 CO-10 adds `carryover` — the dedicated report the Burndown/Capacity badges open.
const REPORT_TYPES = ['burndown', 'velocity', 'capacity', 'carryover'] as const
type ReportType = (typeof REPORT_TYPES)[number]

export function ReportsPage() {
  const { t } = useTranslation('reports')
  const { project, team } = useAppContext()
  // Persist the selected report type across reload (P6-COM-006).
  const [type, setType] = useState<ReportType>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.REPORTS_TYPE)
    return (REPORT_TYPES as readonly string[]).includes(saved ?? '')
      ? (saved as ReportType)
      : 'burndown'
  })
  const [direction, setDirection] = useState<CarryoverDirection>('all')
  function changeType(next: ReportType) {
    setType(next)
    localStorage.setItem(STORAGE_KEYS.REPORTS_TYPE, next)
  }

  const projectId = project?.projectId
  // `undefined` is All Teams — the aggregate, not "no filter".
  const teamId = team?.teamId

  /**
   * The badge's `View report →` (CO-BR-34): the Carryover report on the SAME Iteration. Every
   * iteration report reads its selection through `useSelectedIteration`, which honours the
   * persisted last-viewed id — `rememberIteration` writes it through that hook's own key builder.
   * Read at the report's MOUNT (the type switch mounts it fresh), so the hand-over cannot be stale.
   */
  function openCarryover(iterationId: string) {
    if (projectId) rememberIteration(projectId, iterationId)
    changeType('carryover')
  }

  if (!projectId) {
    return (
      <div className="flex-1 bg-background p-6">
        <EmptyState title={t('selectProject')} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      {/* The `Type` switcher sits WITH the title, not opposite it: it names what the page is
          currently showing, so it reads as part of the heading ("Reports › Velocity") rather
          than as an action. At toolbar scale it also stops a form-sized control out-weighing
          the title beside it. The right side stays free for report-level actions. */}
      <PageHeader
        title={t('title')}
        badge={
          <label className="flex items-center gap-2 text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase">
            {t('type')}
            <CompactSelect
              value={type}
              onChange={(event) => changeType(event.target.value as ReportType)}
              aria-label={t('type')}
            >
              {REPORT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`types.${value}`)}
                </option>
              ))}
            </CompactSelect>
          </label>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col p-4">
        {type === 'burndown' && (
          <IterationBurndownReport
            projectId={projectId}
            teamId={teamId}
            onOpenCarryover={openCarryover}
          />
        )}
        {type === 'velocity' && <VelocityReport projectId={projectId} teamId={teamId} />}
        {type === 'capacity' && (
          <TeamCapacityReport
            projectId={projectId}
            teamId={teamId}
            onOpenCarryover={openCarryover}
          />
        )}
        {type === 'carryover' && (
          <CarryoverReport
            projectId={projectId}
            teamId={teamId}
            direction={direction}
            onDirectionChange={setDirection}
          />
        )}
      </div>
    </div>
  )
}
