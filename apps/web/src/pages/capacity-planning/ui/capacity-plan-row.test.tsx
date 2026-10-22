/**
 * US-120 — the ID cell is a real link to the plan's detail page, so Ctrl/Cmd+click and "Open link in
 * new tab" work. Dropping `href` would silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/features/capacity-planning/api', () => ({
  useUpdateCapacityPlan: () => ({ mutateAsync: vi.fn() }),
}))

import '@/shared/i18n/i18n'
import { CapacityPlanRow } from './capacity-plan-row'
import type { CapacityPlan } from '@/features/capacity-planning/api'

const plan = {
  id: 'plan-1',
  planKey: 'CP-1',
  name: 'Q3 plan',
  releaseId: null,
  status: 'draft',
  updatedAt: '2026-01-01T00:00:00Z',
  teams: [],
} as unknown as CapacityPlan

describe('CapacityPlanRow — ID link', () => {
  it('links the plan key to its capacity-planning detail page', () => {
    render(
      <CapacityPlanRow
        plan={plan}
        canManage={false}
        releaseOptions={[]}
        colStyleFor={() => ({})}
        gutter={null}
      />,
    )
    expect(screen.getByTitle('CP-1').getAttribute('href')).toBe('/capacity-planning/plan-1')
  })
})
