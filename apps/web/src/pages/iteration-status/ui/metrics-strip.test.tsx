/**
 * BA 2026-11-04 — Planned Velocity is PLANNED points against the target, and over 100% (more
 * points planned than the sprint's velocity) is an over-commitment the tile must show in red.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Expose the interpolation values, so the caption's numbers can be asserted.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { current?: number; total?: number }) =>
      key === 'metrics.points' ? `${o?.current} of ${o?.total} Points` : key,
  }),
}))

import { BRAND } from '@/shared/config/brand'
import { MetricsStrip } from './iteration-chrome'

const metrics = {
  plannedVelocityPercent: 0,
  acceptedPoints: 0,
  plannedVelocity: 60,
  acceptedPercent: 0,
  totalPlanEstimate: 0,
  daysLeft: 8,
  totalDays: 10,
  defectCount: 0,
  taskCount: 0,
  activeTaskCount: 0,
}

function renderStrip(velocityPct: number | null, totalPlanEstimate: number) {
  render(
    <MetricsStrip
      metrics={{ ...metrics, plannedVelocityPercent: velocityPct, totalPlanEstimate }}
      velocityPct={velocityPct}
      acceptedPct={0}
      iterationEnd={{ value: '8', label: 'of 10 days left', color: BRAND.warning }}
      iterationProgressPct={20}
    />,
  )
}

describe('MetricsStrip — Planned Velocity', () => {
  it('turns red above 100%', () => {
    renderStrip(120, 72)
    expect(screen.getByText('120%')).toHaveStyle({ color: BRAND.danger })
  })

  it('stays the default colour at exactly 100%', () => {
    renderStrip(100, 60)
    expect(screen.getByText('100%')).toHaveStyle({ color: BRAND.primary })
  })

  it('captions PLANNED points, not accepted ones', () => {
    renderStrip(18, 11)
    expect(screen.getByText('18%')).toHaveStyle({ color: BRAND.primary })
    expect(screen.getByText('11 of 60 Points')).toBeInTheDocument()
  })
})
