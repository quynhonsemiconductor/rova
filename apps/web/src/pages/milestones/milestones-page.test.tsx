/**
 * US-120 — the Milestones grid's ID cell is a real link to the milestone's detail page; dropping
 * `href` would silently fall back to an in-place-only button (no Ctrl/Cmd+click, no new tab).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))
vi.mock('@/pages/timeboxes/timebox-type-switcher', () => ({ TimeboxTypeSwitcher: () => null }))
vi.mock('@/shared/lib/stores/app-context.store', () => ({
  useAppContext: () => ({ project: { projectId: 'proj-1' } }),
}))
vi.mock('@/features/access/api', () => ({ useProjectPermissions: () => ({ can: () => false }) }))
vi.mock('@/features/releases/api', () => ({ useReleases: () => ({ data: [] }) }))
vi.mock('@/features/teams/api', () => ({ useProjectMembers: () => ({ data: [] }) }))
vi.mock('@/features/milestones/api', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useMilestones: () => ({
      data: [
        {
          id: 'ms-7',
          milestoneKey: 'MS-7',
          name: 'Beta launch',
          description: null,
          status: 'planned',
          ownerId: null,
          targetStartDate: null,
          targetEndDate: null,
          releaseIds: [],
        },
      ],
      isLoading: false,
      error: null,
    }),
    useCreateMilestone: () => mutation,
    useUpdateMilestone: () => mutation,
    useDeleteMilestone: () => mutation,
  }
})

import '@/shared/i18n/i18n'
import { MilestonesPage } from './milestones-page'

describe('MilestonesPage', () => {
  it('links the ID cell to the milestone detail URL', () => {
    render(<MilestonesPage />)

    expect(screen.getByTitle('MS-7').getAttribute('href')).toBe('/milestones/ms-7')
  })
})
