import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub env so the store reads a relative API base at module load.
vi.mock('@/shared/config/env', () => ({
  ENV: { API_BASE_URL: '' },
}))
vi.mock('@/shared/api/query-client', () => ({ queryClient: { clear: vi.fn() } }))

import { useAuthStore } from './auth.store'

const membership = (workspaceId: string) => ({
  workspaceId,
  name: workspaceId,
  slug: workspaceId,
  lastActiveAt: null,
  roleSlug: null,
  roleName: null,
})

const user = {
  id: 'u1',
  email: 'u1@acme.dev',
  displayName: 'User One',
  locale: 'en',
  timezone: 'UTC',
  permissions: [],
  emailVerified: true,
  createdAt: '',
  updatedAt: '',
} as never

describe('useAuthStore.switchWorkspace (identity 8 session)', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth()
    vi.unstubAllGlobals()
  })

  it('posts to /v1/auth/switch-workspace with no Authorization header and re-orders memberships', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    useAuthStore.getState().setUser(user, [membership('ws-1'), membership('ws-2')])
    await useAuthStore.getState().switchWorkspace('ws-2')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/v1/bff/switch-workspace')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(init.body).toBe(JSON.stringify({ workspaceId: 'ws-2' }))

    const s = useAuthStore.getState()
    expect(s.activeWorkspaceId).toBe('ws-2')
    expect(s.memberships[0]?.workspaceId).toBe('ws-2')
    expect(s.isSwitchingWorkspace).toBe(false)
  })

  it('throws and clears the switching flag when the server rejects the switch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    useAuthStore.getState().setUser(user, [membership('ws-1'), membership('ws-2')])
    await expect(useAuthStore.getState().switchWorkspace('ws-2')).rejects.toThrow('Switch failed')
    expect(useAuthStore.getState().isSwitchingWorkspace).toBe(false)
  })
})
