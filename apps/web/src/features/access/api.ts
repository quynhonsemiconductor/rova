/**
 * Access / permission hooks.
 *
 * Rova's authorization is two-tier and purely additive:
 *  - BASELINE  = the union of the user's global + workspace role assignments.
 *    It's baked into the JWT and exposed via the auth store's `hasPermission`.
 *  - PER-PROJECT = baseline ∪ any role scoped to a specific project, resolved
 *    server-side and returned by `GET /v1/projects/:projectId/my-permissions`.
 *
 * Workspace-tier UI (navigation, settings) should keep using the auth store's
 * `hasPermission`. Project-scoped UI must use {@link useProjectPermissions} so a
 * user who is, say, admin of one project but only a viewer workspace-wide sees
 * the correct actions on that project.
 */
import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { apiErrorMessage } from '@/shared/api/api-error'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { grants } from '@/shared/config/permission-check'
import { coversAllTeams } from '@/shared/config/access-levels'

export const accessKeys = {
  myProjectPermissions: (projectId: string) => ['my-project-permissions', projectId] as const,
}

export interface ProjectPermissions {
  /** The effective permission codes for the current user on this project. */
  permissions: string[]
  /** Wildcard-aware check against the effective permission set. */
  can: (code: string) => boolean
  isLoading: boolean
  isError: boolean
}

/**
 * The current user's effective permissions for a project. While the per-project
 * set loads (or when no project is selected) it falls back to the workspace
 * baseline from the JWT — safe because the model is additive, so the effective
 * set only ever grows once the project grants resolve (no action a baseline
 * grant allows is ever hidden).
 */
export function useProjectPermissions(projectId: string | undefined): ProjectPermissions {
  const baseline = useAuthStore((s) => s.user?.permissions ?? [])

  const query = useQuery({
    queryKey: accessKeys.myProjectPermissions(projectId ?? ''),
    queryFn: async () => {
      if (!projectId) return [] as string[]
      const { data, error, response } = await apiClient.GET(
        '/v1/projects/{projectId}/my-permissions',
        { params: { path: { projectId } } },
      )
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data?.permissions ?? []
    },
    enabled: !!projectId,
    staleTime: 60_000,
  })

  const permissions = query.data ?? baseline

  return {
    permissions,
    can: (code: string) => grants(permissions, code),
    isLoading: query.isLoading,
    isError: query.isError,
  }
}

/**
 * The caller's TEAM SCOPE in one project — the client half of `AccessService.resolveTeamScope`.
 *
 * BA ruling 2026-08-17: "Null means Project Backlog, accessible only to Workspace Admin and Project
 * Admin. Editor must select one of their assigned Teams when creating a Work Item and cannot access
 * team-less items. Enforce this consistently in API queries, lists, reports, search, pickers and
 * direct URLs." The server refuses a team-less create by an Editor with `WORK_ITEM_TEAM_REQUIRED`
 * (412) and a team-less READ with `PROJECT_BACKLOG_ADMIN_ONLY` (403), so the client's whole job here
 * is to stop offering what those two refuse — without withdrawing the Project Backlog from an admin,
 * for whom "no Team" remains a legitimate, documented choice (WIC-FR-005).
 *
 * ONE hook, because the answer decides three things that must agree on every create surface: whether
 * Team is required, whether the picker offers the empty option, and whether a single team is
 * prefilled. Three surfaces deriving that separately is how they diverge.
 */
export interface ProjectTeamScope {
  /** Workspace Admin or per-project Admin: every Team AND the Project Backlog. */
  unrestricted: boolean
  /**
   * A team-scoped Editor: a Team must be chosen, and `No team` must not be offered.
   *
   * TRUE while the per-project read is still in flight and the workspace baseline alone does not
   * cover all teams — the restrictive direction on purpose. Mis-restricting an admin for one render
   * costs a briefly-hidden option; mis-permitting an Editor offers a choice the server answers with
   * a 412, which is the failure this hook exists to prevent.
   */
  teamRequired: boolean
  isLoading: boolean
}

export function useProjectTeamScope(projectId: string | undefined): ProjectTeamScope {
  const { permissions, isLoading } = useProjectPermissions(projectId)
  const unrestricted = coversAllTeams(permissions)
  return { unrestricted, teamRequired: !unrestricted, isLoading }
}

/**
 * Effective permissions for SEVERAL projects at once, keyed by project id.
 *
 * For cross-project grids — the Portfolio list spans projects, so "can I edit this row"
 * is a different answer per row and `useProjectPermissions` (one project) cannot express
 * it. Gating the whole grid on the currently-selected project would either hide actions
 * the user does have elsewhere or show ones they do not.
 *
 * Reuses `accessKeys.myProjectPermissions`, so every entry shares cache with the
 * single-project hook and a project already resolved costs no extra request — the same
 * arrangement `useReleasesForProjects` uses.
 */
export function useProjectPermissionsFor(projectIds: readonly string[]): {
  can: (projectId: string | undefined, code: string) => boolean
  isLoading: boolean
} {
  const baseline = useAuthStore((s) => s.user?.permissions ?? [])
  const ids = useMemo(() => [...new Set(projectIds.filter(Boolean))], [projectIds])

  const results = useQueries({
    queries: ids.map((projectId) => ({
      queryKey: accessKeys.myProjectPermissions(projectId),
      queryFn: async () => {
        const { data, error, response } = await apiClient.GET(
          '/v1/projects/{projectId}/my-permissions',
          { params: { path: { projectId } } },
        )
        if (error) throw new Error(apiErrorMessage(error, response.status))
        return data?.permissions ?? []
      },
      staleTime: 60_000,
    })),
  })

  // Stable signature so the map is rebuilt only when a fetch actually lands, not on
  // every render (same reason `useReleasesForProjects` does it).
  const signature = results.map((r) => r.dataUpdatedAt).join(',')
  const idKey = ids.join(',')
  const byProject = useMemo(() => {
    const map = new Map<string, string[]>()
    ids.forEach((id, i) => map.set(id, results[i]?.data ?? baseline))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, idKey])

  return {
    // Falls back to the workspace baseline, which is safe because the model is purely
    // additive: the effective set only grows once project grants resolve, so no action a
    // baseline grant already allows is ever hidden mid-load.
    can: (projectId, code) =>
      grants(projectId ? (byProject.get(projectId) ?? baseline) : baseline, code),
    isLoading: results.some((r) => r.isLoading),
  }
}
