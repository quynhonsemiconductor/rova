import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { withCsrfHeader } from '@/shared/api/csrf'
import { queryClient } from '@/shared/api/query-client'
import { ENV } from '@/shared/config/env'
import { grants } from '@/shared/config/permission-check'

export interface WorkspaceMembership {
  workspaceId: string
  name: string
  slug: string
  lastActiveAt: string | null
  /** User's primary role slug in this workspace, e.g. 'workspace_admin'. Null when no assignment exists. */
  roleSlug: string | null
  /** Human-readable role name, e.g. 'Workspace Admin'. */
  roleName: string | null
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
  avatarUrl?: string | null
  locale: string
  timezone: string
  phone?: string | null
  role: string
  permissions: string[]
  emailVerified: boolean
  createdAt: string
  updatedAt: string
}

interface AuthState {
  user: AuthUser | null
  memberships: WorkspaceMembership[]
  activeWorkspaceId: string | null
  isAuthenticated: boolean
  isLoading: boolean
  isSwitchingWorkspace: boolean

  setUser: (user: AuthUser, memberships?: WorkspaceMembership[]) => void
  clearAuth: () => void
  setLoading: (loading: boolean) => void
  switchWorkspace: (workspaceId: string) => Promise<void>

  /** True if the user has the given permission code in their current role. */
  hasPermission: (code: string) => boolean
}

const API = ENV.API_BASE_URL

export const useAuthStore = create<AuthState>()(
  devtools(
    (set, get) => ({
      user: null,
      memberships: [],
      activeWorkspaceId: null,
      isAuthenticated: false,
      isLoading: true,
      isSwitchingWorkspace: false,

      setUser: (user, memberships = []) => {
        const activeWorkspaceId = memberships[0]?.workspaceId ?? null
        set({ user, memberships, activeWorkspaceId, isAuthenticated: true, isLoading: false })
      },

      clearAuth: () => {
        set({
          user: null,
          memberships: [],
          activeWorkspaceId: null,
          isAuthenticated: false,
          isLoading: false,
        })
      },

      setLoading: (isLoading) => set({ isLoading }),

      switchWorkspace: async (workspaceId: string) => {
        const { activeWorkspaceId } = get()
        if (workspaceId === activeWorkspaceId) return

        set({ isSwitchingWorkspace: true })
        try {
          // The server moves the SAME session to the workspace (identity's `setContext`, after asking
          // `workspace_members` whether the caller may act there); the browser keeps its session cookie
          // and holds no tokens, so there is nothing to store client-side. A 204 means the session now
          // resolves to the new workspace; a 403 means the caller is not a member.
          const res = await fetch(`${API}/v1/auth/switch-workspace`, {
            method: 'POST',
            credentials: 'include',
            referrerPolicy: 'no-referrer',
            headers: withCsrfHeader('POST', { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ workspaceId }),
          })
          if (!res.ok) throw new Error('Switch failed')

          queryClient.clear()

          // Re-order memberships so switched workspace is first
          const { memberships } = get()
          const reordered = [
            ...memberships.filter((m) => m.workspaceId === workspaceId),
            ...memberships.filter((m) => m.workspaceId !== workspaceId),
          ]
          set({ activeWorkspaceId: workspaceId, memberships: reordered })
        } finally {
          set({ isSwitchingWorkspace: false })
        }
      },

      hasPermission: (code) => {
        const { user } = get()
        if (!user) return false
        return grants(user.permissions, code)
      },
    }),
    { name: 'auth-store' },
  ),
)
