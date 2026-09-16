/**
 * Teams API hooks — TanStack Query wrappers.
 * Used by Work Item Detail sidebar dropdowns and Settings > Teams management.
 */
import { useMemo } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/shared/api/http-client'
import { ApiError, apiErrorMessage } from '@/shared/api/api-error'
import type { AccessLevel } from '@/shared/config/access-levels'

// ── Types (generated schema uses Record<string,never> for team types) ─────────

/** A project a team is actively linked to (via project_teams). */
export interface TeamProjectLink {
  projectId: string
  key: string
  name: string
}

export interface Team {
  id: string
  workspaceId: string
  name: string
  key: string
  description: string | null
  leadId: string | null
  status: 'active' | 'archived'
  memberCount?: number
  /** Active project links, oldest-first; first is the "primary" for the list column. */
  projects?: TeamProjectLink[]
  createdAt: string
  updatedAt: string
}

export interface TeamMember {
  id: string
  teamId: string
  userId: string
  status: string
  joinedAt: string
  /** Resolved from workspace members at query time */
  displayName?: string
  email?: string
  avatarUrl?: string | null
  /**
   * This roster row is a WORKSPACE ADMIN — render the `Workspace Admin` badge, never an access
   * level (BA team-membership ruling; `shared/ui/workspace-admin-badge.tsx` carries the reasoning).
   *
   * Optional because the field is newer than the committed `shared/api/generated/api.ts`. That costs
   * nothing here: every type in this block is hand-declared already (the generated schema types the
   * team responses as `Record<string, never>`, which is why `fetchTeamMembers` casts), so declaring
   * one more field is the file's existing escape hatch rather than a second one. `undefined` and
   * `false` mean the same thing to every reader — no badge — so a client that predates the server
   * field degrades to today's behaviour instead of mislabelling anyone.
   */
  isWorkspaceAdmin?: boolean
}

export interface ProjectMember {
  id: string
  userId: string
  workspaceId: string
  projectId: string
  accessLevel: AccessLevel | null
  status: string
  displayName?: string
  email?: string
  avatarUrl?: string | null
  joinedAt: string
  updatedAt: string
  /** Active team_members rows for Teams linked to this project — 0 means an Editor has no scope to act in. */
  teamCount: number
  /**
   * TRUE for the SYNTHESIZED, read-only Workspace Admin row (BA report 2026-08-21).
   *
   * No `work.project_members` record exists behind it, it is excluded from `memberCount`, and it
   * carries no Access Level control and no Remove. Branch on THIS, never on `accessLevel === null` —
   * a null level already means "team-derived row" on a real member.
   */
  isWorkspaceAdmin?: boolean
}

/**
 * The REFERENCE projection of a project member — what a picker or a name lookup needs.
 *
 * Mirrors `ProjectMemberOptionResponseDto`. A type of its own, not `Pick<ProjectMember, …>`: the
 * roster type carries `accessLevel`, `status` and `teamCount`, and a shared base is how a field added
 * for User Management joins the feed every delivery participant reads. Structurally this is
 * `OwnerSelectMember` (`shared/ui/owner-cell`), which is what every owner picker already accepts.
 */
export interface ProjectMemberOption {
  userId: string
  displayName?: string | null
  email?: string | null
  avatarUrl?: string | null
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const teamKeys = {
  all: ['teams'] as const,
  workspaceTeams: (workspaceId: string, includeInactive = false) =>
    [...teamKeys.all, 'workspace', workspaceId, includeInactive] as const,
  detail: (id: string) => [...teamKeys.all, 'detail', id] as const,
  members: (id: string) => [...teamKeys.all, 'members', id] as const,
  projectTeams: (projectId: string) => [...teamKeys.all, 'project', projectId] as const,
  projectMembers: (projectId: string) => [...teamKeys.all, 'projectMembers', projectId] as const,
} as const

// ── Queries ───────────────────────────────────────────────────────────────────

export function useWorkspaceTeams(workspaceId: string | undefined, includeInactive = false) {
  return useQuery({
    queryKey: teamKeys.workspaceTeams(workspaceId ?? '', includeInactive),
    queryFn: async () => {
      if (!workspaceId) return []
      const { data, error, response } = await apiClient.GET('/v1/workspaces/{workspaceId}/teams', {
        params: {
          path: { workspaceId },
          ...(includeInactive ? { query: { includeInactive: true } } : {}),
        },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as Team[]) ?? []
    },
    enabled: !!workspaceId,
    staleTime: 30_000,
  })
}

export function useTeam(id: string | undefined) {
  return useQuery({
    queryKey: teamKeys.detail(id ?? ''),
    queryFn: async () => {
      const { data, error, response } = await apiClient.GET('/v1/teams/{id}', {
        params: { path: { id: id! } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Team
    },
    enabled: !!id,
    staleTime: 30_000,
  })
}

async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
  const { data, error, response } = await apiClient.GET('/v1/teams/{id}/members', {
    params: { path: { id: teamId } },
  })
  if (error) throw new Error(apiErrorMessage(error, response.status))
  return (data as TeamMember[]) ?? []
}

/** One team's full member roster — the team DETAIL view on the project Teams tab
 *  (mockup parity: clicking a team row shows its members). Shares cache with the
 *  memberships fan-out via `teamKeys.members`. */
export function useTeamMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: teamKeys.members(teamId ?? ''),
    queryFn: () => fetchTeamMembers(teamId as string),
    enabled: !!teamId,
    staleTime: 30_000,
  })
}

/**
 * Membership across SEVERAL teams for one user. The per-project Teams picker in
 * UserAccessModal needs "is this user in team X" for every team on a project
 * row, and there is no single endpoint for that, so this fans out one request
 * per team via `useQueries`. Uses `teamKeys.members` / `fetchTeamMembers` so
 * results share cache with `useTeamMembers` (e.g. the Teams tab's member cell),
 * and stay live after `useAddTeamMember` / `useRemoveTeamMember` — both
 * invalidate the `team` tag, whose `['teams']` root covers `teamKeys.members`
 * by prefix.
 */
export function useUserTeamMemberships(teamIds: readonly string[], userId: string | undefined) {
  const ids = useMemo(() => [...new Set(teamIds.filter(Boolean))], [teamIds])
  const results = useQueries({
    queries: ids.map((teamId) => ({
      queryKey: teamKeys.members(teamId),
      queryFn: () => fetchTeamMembers(teamId),
      enabled: !!userId,
      staleTime: 30_000,
    })),
  })
  const isLoading = results.some((r) => r.isLoading)
  // Stable signatures so the memo only recomputes when the underlying data
  // (or the team-id set itself) actually changes, not on every render.
  const signature = results.map((r) => r.dataUpdatedAt).join(',')
  const idsSignature = ids.join(',')
  const memberTeamIds = useMemo(
    () => (userId ? ids.filter((_, i) => results[i]?.data?.some((m) => m.userId === userId)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, userId, idsSignature],
  )
  return { memberTeamIds, isLoading }
}

/**
 * Raw shape returned by `GET /v1/projects/{id}/teams` — a `project_team` LINK
 * row, where `id` is the link id and `teamId` is the actual team id.
 */
interface ProjectTeamLinkRow extends Team {
  teamId: string
}

export function useProjectTeams(projectId: string | undefined) {
  return useQuery({
    queryKey: teamKeys.projectTeams(projectId ?? ''),
    queryFn: async () => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/projects/{id}/teams', {
        params: { path: { id: projectId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      // The endpoint returns project_team LINK rows: `.id` is the link id and
      // `.teamId` is the real team id. Normalize so `.id` is the TEAM id — every
      // consumer treats this list as teams keyed by team id (Edit Project
      // checkbox matching, team-name lookups, pickers). The link id is never
      // used on the client (unlink is by teamId).
      const links = (data as ProjectTeamLinkRow[]) ?? []
      return links.map((l): Team => ({ ...l, id: l.teamId }))
    },
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

/**
 * The ASSIGNEE feed for a project — id, name, email, avatar, and nothing else.
 *
 * Use this for owner pickers and for resolving an owner's NAME. {@link useProjectMembers} reads the
 * administrative roster, which is `workspace:view`-equivalent (Workspace Admin or Project Admin only,
 * §3.1:71) because it carries `accessLevel`, `status` and `teamCount`.
 *
 * That mattered more than it looks: the roster was ALSO the only owner feed, so gating it left every
 * Editor's Backlog and Iteration Status with `members = []` — and both surfaces derive the displayed
 * owner name from that list, so every owned item read `Unassigned` and the owner could not be changed,
 * while §3.2:79 grants an Editor exactly that write.
 */
export function useProjectMemberOptions(projectId: string | undefined) {
  return useQuery({
    queryKey: [...teamKeys.projectMembers(projectId ?? ''), 'options'] as const,
    queryFn: async () => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/projects/{id}/member-options', {
        params: { path: { id: projectId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? []
    },
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

/**
 * OWNER OPTIONS for a record that carries a Team (GAP-P1-WID-007).
 *
 * "Work Item and Task Owner default to Unassigned. Selected Team offers Unassigned plus its ACTIVE
 * MEMBERS; No Team offers only Unassigned. Do not add No Team or unrelated Workspace users to Owner
 * options." Both halves live here so no caller can implement one and forget the other:
 *
 *  - a `teamId` reads the same `member-options` route with `?teamId=`, which returns that team's
 *    active roster (one feed, one gate — the route still carries `project:view` on the path id);
 *  - NO `teamId` never fetches at all, so `data` is `undefined` and the caller's `?? []` yields the
 *    empty list the rule asks for. Falling through to the project-wide feed here is the defect this
 *    hook exists to make unreachable.
 *
 * This is NOT a replacement for {@link useProjectMemberOptions}. That one stays the id→name source:
 * an item's CURRENT owner may have left the team, and a picker whose label resolves out of the
 * narrowed list reprints them as the placeholder — the `searchable-select` "absent value reads as
 * unset" defect. Callers pass the already-set owner alongside these options.
 */
export function useTeamOwnerOptions(
  projectId: string | undefined,
  teamId: string | null | undefined,
) {
  return useQuery({
    queryKey: [
      ...teamKeys.projectMembers(projectId ?? ''),
      'options',
      'team',
      teamId ?? '',
    ] as const,
    queryFn: async () => {
      if (!projectId || !teamId) return []
      const { data, error, response } = await apiClient.GET('/v1/projects/{id}/member-options', {
        params: { path: { id: projectId }, query: { teamId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data ?? []
    },
    enabled: !!projectId && !!teamId,
    staleTime: 60_000,
  })
}

/**
 * The full administrative roster AS SERVED: real `project_members` rows plus the synthesized,
 * read-only Workspace Admin rows.
 *
 * Workspace Admin / Project Admin only (§3.1:71). Use this only where the BA's system row belongs —
 * Project `Users & Permissions`. Everywhere else use {@link useProjectMembers}, which drops it.
 */
export function useProjectAccessRoster(projectId: string | undefined) {
  return useQuery({
    queryKey: teamKeys.projectMembers(projectId ?? ''),
    queryFn: async () => {
      if (!projectId) return []
      const { data, error, response } = await apiClient.GET('/v1/projects/{id}/members', {
        params: { path: { id: projectId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return (data as ProjectMember[] | undefined) ?? []
    },
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

/**
 * The ADMINISTRATIVE roster of real MEMBERS: access level, status and team count per member.
 *
 * Workspace Admin / Project Admin only (§3.1:71). For an owner picker or an owner NAME, use
 * {@link useProjectMemberOptions} — this one 403s for an Editor, and a caller that defaults the error
 * to `[]` will render every owned item as unassigned.
 *
 * Drops the synthesized Workspace Admin rows the endpoint now returns, so every existing caller keeps
 * the population it was written against: this feed backs member COUNTS and two owner pickers, and §2.1
 * still says a Workspace Admin is not a Project member. One shared query key with
 * {@link useProjectAccessRoster} — same request, two projections — so the split costs no extra fetch.
 */
export function useProjectMembers(projectId: string | undefined) {
  const roster = useProjectAccessRoster(projectId)
  return {
    ...roster,
    data: roster.data?.filter((m) => !m.isWorkspaceAdmin),
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export interface CreateTeamInput {
  workspaceId: string
  name: string
  key: string
  description?: string
  leadId?: string | null
  status?: 'active' | 'archived'
  /** Required by the API (≥1); a team must link to at least one project. */
  projectIds: string[]
  memberUserIds?: string[]
}

export function useCreateTeam() {
  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateTeamInput) => {
      const { data, error, response } = await apiClient.POST('/v1/workspaces/{workspaceId}/teams', {
        params: { path: { workspaceId } },
        body: body as never,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Team
    },
    // The `team` tag invalidates the whole teams namespace (workspace lists,
    // project-team links, member lists) plus dependent dashboards.
    meta: { invalidates: ['team'] },
  })
}

export interface UpdateTeamInput {
  /** Correcting a key a rename left behind — see `UpdateProjectInput.key`. */
  key?: string
  name?: string
  description?: string | null
  leadId?: string | null
  status?: 'active' | 'archived'
  /** When supplied, replaces the full set of linked projects (≥1). */
  projectIds?: string[]
  /** When supplied, replaces the full set of members. */
  memberUserIds?: string[]
}

export function useUpdateTeam(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: UpdateTeamInput) => {
      const { data, error, response } = await apiClient.PATCH('/v1/teams/{id}', {
        params: { path: { id } },
        body: body as never,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as Team
    },
    onSuccess: (team) => qc.setQueryData(teamKeys.detail(id), team),
    meta: { invalidates: ['team'] },
  })
}

/**
 * `DELETE /v1/teams/{id}` — remove an ARCHIVED team that holds no delivery history.
 *
 * The one destructive team write, and the server decides whether it is allowed. Two refusals, both
 * `412`, and the SPA must not pre-empt either:
 *
 *  • `TEAM_NOT_ARCHIVED` — delete is an operation on the archive, so a team is archived first. This
 *    hook is only reachable from `Settings > Archive`, where every row is archived by construction.
 *  • `TEAM_HAS_HISTORY` — work items, tasks, iterations, portfolio items, capacity rows or frozen
 *    report snapshots still name this team. The MESSAGE names them and their counts, which is the
 *    only actionable part of the refusal, so a caller must render `error.message` rather than a
 *    generic failure line. Nothing on the client can compute this answer — half the referencing
 *    columns carry no foreign key — so there is no "is it deletable?" flag to gate the button on and
 *    the action is offered unconditionally.
 *
 * Throws {@link ApiError} rather than a bare `Error`: the message is what a reader needs and the
 * CODE is what a surface branches on, and TanStack hands `onError` only the thrown value.
 */
export function useDeleteTeam() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { error, response } = await apiClient.DELETE('/v1/teams/{id}', {
        params: { path: { id } },
      })
      if (error) throw new ApiError(error, response.status)
    },
    // 'project' as well as 'team': a deleted team takes its `project_teams` links with it, so the
    // project tree, the per-project Teams tab and every project row's `teamCount` are all stale.
    meta: { invalidates: ['team', 'project'] },
  })
}

/**
 * `teamId` is optional at the hook level so ONE instance can serve a picker that
 * varies the TEAM rather than the user (the per-project Teams picker in
 * UserAccessModal: one user, many candidate teams). The Teams tab's own
 * `TeamMembersCell` (one team, many candidate users) still binds `teamId` here
 * and calls `.mutate(userId)` exactly as before — both shapes hit the same
 * `POST /v1/teams/{id}/members`, so there is still exactly one write path.
 */
export function useAddTeamMember(teamId?: string) {
  return useMutation({
    mutationFn: async (arg: string | { userId: string; teamId: string }) => {
      const [id, userId] = typeof arg === 'string' ? [teamId, arg] : [arg.teamId, arg.userId]
      if (!id) throw new Error('useAddTeamMember: no teamId bound or supplied')
      const { data, error, response } = await apiClient.POST('/v1/teams/{id}/members', {
        params: { path: { id } },
        body: { userId } as never,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data as TeamMember
    },
    meta: { invalidates: ['team'] },
  })
}

/** See {@link useAddTeamMember} for why `teamId` is optional here too. */
export function useRemoveTeamMember(teamId?: string) {
  return useMutation({
    mutationFn: async (arg: string | { userId: string; teamId: string }) => {
      const [id, userId] = typeof arg === 'string' ? [teamId, arg] : [arg.teamId, arg.userId]
      if (!id) throw new Error('useRemoveTeamMember: no teamId bound or supplied')
      const { error, response } = await apiClient.DELETE('/v1/teams/{id}/members/{userId}', {
        params: { path: { id, userId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    // 'work-item' is invalidated because removal now nulls the member's task
    // assignments in this team — Iteration Status, Work Item detail and Backlog
    // all render task assignees, so they must refetch or they show a stale owner.
    meta: { invalidates: ['team', 'work-item'] },
  })
}

// ── Per-Project access: level + Teams, ONE write (PRJ-08) ─────────────────────

/**
 * Set a user's access level for a Project AND the Teams it is scoped to, in one request.
 *
 * The ONE level-write path in the SPA, and the ONE endpoint all three §5 journeys use (AC-9: "All
 * three journeys update the same Project access and Team membership source"). It replaces THREE
 * separate call shapes that every combined edit used to issue in sequence — `POST
 * /projects/{id}/members`, `PATCH /projects/{id}/members/{memberId}` and one `POST
 * /teams/{id}/members` per team — and with them a `useUpdateProjectAccess` hook whose only reason to
 * exist was that the POST could not carry a level.
 *
 * Why one request and not three: §2.2's "an Editor must be assigned to at least one active Team" is
 * only decidable when the level and the Teams arrive together, so the server could not refuse the
 * invalid state without rejecting the first of several calls the screen legitimately makes. It can
 * now, and the write is a single transaction — so a failed team write no longer leaves the level
 * standing with no teams behind it, the state the Editor Teams dialog had to mitigate by ORDERING its
 * requests.
 *
 * `teamIds` ABSENT means "leave the memberships alone"; `[]` means "remove them all", which for an
 * Editor is exactly what the server refuses. Do not collapse the two.
 *
 * The body used to need an `as never` cast: the handler declared an inline TypeScript type Swagger
 * could not see, so the generated client typed it `never`. `SetProjectAccessDto` makes it a real
 * schema, the client has been regenerated, and the cast is gone — which is the point of naming a
 * removal condition rather than leaving a permanent escape hatch.
 */
export function useSetProjectAccess(projectId: string) {
  return useMutation({
    mutationFn: async ({
      userId,
      accessLevel,
      teamIds,
    }: {
      userId: string
      accessLevel?: AccessLevel
      teamIds?: string[]
    }) => {
      const { data, error, response } = await apiClient.POST('/v1/projects/{id}/members', {
        params: { path: { id: projectId } },
        body: {
          userId,
          ...(accessLevel ? { accessLevel } : {}),
          ...(teamIds ? { teamIds } : {}),
        },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
      return data
    },
    // 'work-item' as well as 'team': dropping a team membership nulls that member's task
    // assignments in the team (see `useRemoveTeamMember`), and this write can drop one.
    meta: { invalidates: ['team', 'work-item'] },
  })
}

// ── Project ⇄ Team links ──────────────────────────────────────────────────────

export function useLinkProjectTeam(projectId: string) {
  return useMutation({
    mutationFn: async (teamId: string) => {
      const { error, response } = await apiClient.POST('/v1/projects/{id}/teams', {
        params: { path: { id: projectId } },
        body: { teamId } as never,
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    // A project⇄team link shows on both the team's project list and the
    // project's team list, so refresh both namespaces.
    meta: { invalidates: ['team', 'project'] },
  })
}

export function useUnlinkProjectTeam(projectId: string) {
  return useMutation({
    mutationFn: async (teamId: string) => {
      const { error, response } = await apiClient.DELETE('/v1/projects/{id}/teams/{teamId}', {
        params: { path: { id: projectId, teamId } },
      })
      if (error) throw new Error(apiErrorMessage(error, response.status))
    },
    meta: { invalidates: ['team', 'project'] },
  })
}
