/**
 * BA report 2026-11-04 — Estimation Settings inputs could not be cleared: the onChange dropped any
 * value that was not `> 0`, so deleting "8" from Hours per point snapped straight back to "8".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mutateAsync = vi.fn().mockResolvedValue({})

vi.mock('@/features/projects/api', () => ({
  useCreateProject: () => ({ mutateAsync, isPending: false }),
}))
vi.mock('@/features/workspaces/api', () => ({
  useWorkspaceMemberOptions: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/features/teams/api', () => ({
  useWorkspaceTeams: () => ({ data: [], isLoading: false }),
  useProjectTeams: () => ({ data: [] }),
  useProjectMemberOptions: () => ({ data: [] }),
  useLinkProjectTeam: () => ({ mutate: vi.fn() }),
  useUnlinkProjectTeam: () => ({ mutate: vi.fn() }),
}))

import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { NewProjectModal } from './project-parts'

function signInAsWorkspaceAdmin() {
  useAuthStore.setState({
    user: {
      id: 'u-1',
      email: 'wa@qnsc.dev',
      displayName: 'WA',
      locale: 'en',
      timezone: 'UTC',
      role: 'member',
      permissions: ['workspace:*'],
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    isAuthenticated: true,
    isLoading: false,
  })
}

describe('NewProjectModal — Estimation Settings inputs', () => {
  beforeEach(() => {
    mutateAsync.mockClear()
    signInAsWorkspaceAdmin()
  })

  function setup() {
    render(<NewProjectModal workspaceId="ws-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('e.g. NX Platform'), {
      target: { value: 'NX Platform' },
    })
    return {
      hours: screen.getByLabelText('Hours per point') as HTMLInputElement,
      submit: screen.getByRole('button', { name: /create/i }),
    }
  }

  it('lets Hours per point be cleared and retyped, and sends the new value', async () => {
    const { hours, submit } = setup()

    fireEvent.change(hours, { target: { value: '' } })
    expect(hours.value).toBe('')
    expect(submit).toBeDisabled()

    fireEvent.change(hours, { target: { value: '6' } })
    expect(hours.value).toBe('6')
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled())
    expect(mutateAsync.mock.calls[0][0].estimationSettings).toMatchObject({ hoursPerPoint: 6 })
  })

  it('lets a T-shirt point value be cleared too', () => {
    const { submit } = setup()
    const xs = screen.getByLabelText('XS') as HTMLInputElement

    fireEvent.change(xs, { target: { value: '' } })
    expect(xs.value).toBe('')
    expect(submit).toBeDisabled()

    fireEvent.change(xs, { target: { value: '2' } })
    expect(submit).toBeEnabled()
  })
})
