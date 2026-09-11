import { BRAND } from '@/shared/config/brand'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useMatches, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Check,
  HelpCircle,
  Layers,
  LogOut,
  Search,
  Settings,
  User,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageErrorBoundary } from '@/shared/ui/error-boundary'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { Avatar } from '@/shared/ui/avatar'
import { KeyChip } from '@/shared/ui/key-chip'
import { useWorkspaces } from '@/features/workspaces/api'
import { useProjects } from '@/features/projects/api'
import { useInitialProject } from '@/features/projects/use-initial-project'
import { useProjectTeams, type Team } from '@/features/teams/api'
import { useNotificationUnreadCount, useNotificationSse } from '@/features/notifications/api'
import { useProjectPermissions } from '@/features/access/api'
import { revokeSession } from '@/shared/api/sign-out'
import { isFeatureEnabled } from '@/shared/config/feature-flags'
// The nav table now lives in `shared/config` so the ROUTER reads the same rows this shell does.
// Before that the pairing existed only here: the nav hid an item the caller lacked the code for and
// the router checked nothing, so a bookmarked `/portfolio` rendered an empty grid for a project
// Editor. See `shared/config/nav.ts` for the full note; do NOT copy a code back into this file.
import { NAV_ITEMS, isNavGroupActive, isNavPathActive, type NavItem } from '@/shared/config/nav'
import { queryClient } from '@/shared/api/query-client'
import { NotificationPopover } from '@/widgets/notification-popover/notification-popover'
import { GlobalSearch } from './global-search'

/**
 * A single row in the workspace-switcher "Projects & Teams" tree. The row can be
 * expanded to reveal the project's teams, which are fetched lazily (only once the
 * row is opened) so a workspace with hundreds of projects never fans out into
 * hundreds of team requests.
 */
function ProjectTreeItem({
  project,
  selected,
  expanded,
  currentTeamId,
  onToggleExpand,
  onSelectProject,
  onSelectTeam,
}: {
  project: { id: string; key: string; name: string }
  selected: boolean
  expanded: boolean
  currentTeamId: string | null
  onToggleExpand: () => void
  onSelectProject: () => void
  /** Pass a team to scope to it, or `null` for "All Teams". */
  onSelectTeam: (team: Team | null) => void
}) {
  const { data: teams = [], isLoading } = useProjectTeams(expanded ? project.id : undefined)
  /**
   * `status` here is the project↔team LINK's, not the team's own — `GET /projects/:id/teams` projects
   * `project_teams.status` over the `teams` row it joins, and `useProjectTeams` keeps that field. So
   * this filter never hid an ARCHIVED team, which is what it is often read as doing; the server does
   * that, and only since the feed gained a `teams.status` predicate (P5-CP-006). Kept because an
   * unlinked row reaching a delivery-context picker would still be wrong.
   */
  const activeTeams = teams.filter((t) => t.status === 'active')

  return (
    <div>
      <div
        className="flex items-center gap-1 rounded hover:bg-surface-subtle"
        style={{ color: selected ? BRAND.primary : BRAND.textPrimary }}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse project' : 'Expand project'}
          aria-expanded={expanded}
          onClick={onToggleExpand}
          className="flex h-6 w-5 shrink-0 items-center justify-center rounded hover:bg-surface-subtle"
        >
          <ChevronRight
            size={12}
            className="text-foreground-subtle"
            style={{
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms',
            }}
          />
        </button>
        <button
          type="button"
          onClick={onSelectProject}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
          style={{ fontWeight: selected ? 600 : 400 }}
        >
          <KeyChip size="sm">{project.key}</KeyChip>
          <span className="truncate text-ui-sm">{project.name}</span>
          {selected && <Check size={10} className="ml-auto shrink-0 text-primary" />}
        </button>
      </div>
      {expanded && (
        <div className="mb-0.5 ml-5 border-l border-border-subtle pl-1.5">
          <button
            type="button"
            onClick={() => onSelectTeam(null)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-subtle"
            style={{
              color: selected && !currentTeamId ? BRAND.primary : BRAND.textPrimary,
              fontWeight: selected && !currentTeamId ? 600 : 400,
            }}
          >
            <Users size={11} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-ui-sm">All Teams</span>
            {selected && !currentTeamId && (
              <Check size={10} className="ml-auto shrink-0 text-primary" />
            )}
          </button>
          {isLoading && (
            <div className="px-1.5 py-1 text-ui-xs text-foreground-subtle">Loading teams…</div>
          )}
          {!isLoading &&
            activeTeams.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTeam(t)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-subtle"
                style={{
                  color: currentTeamId === t.id ? BRAND.primary : BRAND.textPrimary,
                  fontWeight: currentTeamId === t.id ? 600 : 400,
                }}
              >
                <KeyChip size="sm" tone="muted">
                  {t.key}
                </KeyChip>
                <span className="truncate text-ui-sm">{t.name}</span>
                {currentTeamId === t.id && (
                  <Check size={10} className="ml-auto shrink-0 text-primary" />
                )}
              </button>
            ))}
          {!isLoading && activeTeams.length === 0 && (
            <div className="px-1.5 py-1 text-ui-xs text-foreground-subtle">
              No teams in this project yet
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AppShell() {
  const { t } = useTranslation('auth')
  const { user, memberships, activeWorkspaceId } = useAuthStore()
  const { workspace, project, team, setWorkspace, setProject, setTeam } = useAppContext()
  const navigate = useNavigate()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const matches = useMatches()

  const [wsOpen, setWsOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  // Which top-nav dropdown is open, keyed by nav label (Plan, Track, …). Only one at a time.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  // Workspace-switcher project tree state (filter + which project is expanded).
  const [projectSearch, setProjectSearch] = useState('')
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)

  /**
   * The caller's effective permissions in the SELECTED project — the set the nav must gate on.
   * See `navItemState` for why the workspace baseline cannot serve here.
   */
  const { can: canInProject } = useProjectPermissions(project?.projectId)

  const { data: unreadCount = 0 } = useNotificationUnreadCount()

  // SSE real-time push — updates unread count and shows toast on new notifications.
  // Falls back to the 60s poll above when the stream is unavailable.
  useNotificationSse((payload) => {
    toast(payload.title, {
      description: payload.body ?? undefined,
      duration: 5000,
    })
  })

  // Breadcrumb route segments: matches that declare a breadcrumb label.
  const routeCrumbs = matches
    .filter((m) => (m.staticData as { breadcrumb?: string })?.breadcrumb)
    .map((m) => (m.staticData as { breadcrumb: string }).breadcrumb)
  // Optional top-nav section (e.g. 'Track') declared by the leaf route.
  const leafSection = (matches[matches.length - 1]?.staticData as { section?: string } | undefined)
    ?.section

  // Bootstrap workspace context from API — always sync name/slug in case they changed
  const { data: workspaces } = useWorkspaces()
  const projectsQuery = useProjects(workspace?.workspaceId)
  const activeProjects = projectsQuery.data ?? []
  const navProjects = activeProjects.filter((p) => p.status === 'active')
  // Somebody has to pick the first one, and until this hook nobody did: with `project === null`
  // every nav item and route guard resolves its permission against no project, so a freshly granted
  // per-project Admin saw Home and Access Denied everywhere — a No Access experience for a user who
  // has access. Passes the RAW `data`, not the defaulted array: `undefined` means "not resolved" and
  // the hook must not decide on it.
  useInitialProject(projectsQuery.data)

  // Prefix the route breadcrumb with the active scope so a project page reads
  // "Workspace › Project › [Section] › Page" (SHELL-FR-007, P3-TS-FR-002).
  // Workspace-level pages have no project context and keep just their route crumbs.
  const activeProjectName = activeProjects.find((p) => p.id === project?.projectId)?.name
  const scopeCrumbs: string[] = []
  if (workspace?.workspaceName) scopeCrumbs.push(workspace.workspaceName)
  if (activeProjectName) scopeCrumbs.push(activeProjectName)
  if (leafSection) scopeCrumbs.push(leafSection)
  const crumbs = [...scopeCrumbs, ...routeCrumbs]
  // Filter the workspace-switcher project list so the dropdown stays usable even
  // when a workspace has hundreds of projects.
  const projectQuery = projectSearch.trim().toLowerCase()
  const filteredNavProjects = projectQuery
    ? navProjects.filter(
        (p) =>
          p.name.toLowerCase().includes(projectQuery) || p.key.toLowerCase().includes(projectQuery),
      )
    : navProjects

  const selectedTeamName = team?.teamName ?? 'All Teams'
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return
    const first = workspaces[0]
    // Always sync from API — name or slug may have changed since last persist
    if (
      !workspace ||
      workspace.workspaceId !== first.id ||
      workspace.workspaceName !== first.name ||
      workspace.workspaceSlug !== first.slug
    ) {
      setWorkspace({ workspaceId: first.id, workspaceSlug: first.slug, workspaceName: first.name })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces])

  /**
   * SHELL-FR-005: invalidate EVERY project/team-scoped query when either half of the context
   * changes — "invalidate/refetch toàn bộ Project/Team-scoped query. Không giữ route hoặc dữ liệu
   * của context cũ."
   *
   * A team change used to invalidate `['work-items']` alone, which is narrower than the rule and
   * narrower than the truth: iterations, capacity, reports, team status and the pickers are all
   * team-scoped too, so each kept serving the previous team's rows until its own staleness expired.
   * One blanket invalidation for both, because the requirement draws no distinction between them.
   */
  const projectId = project?.projectId
  const teamId = team?.teamId
  useEffect(() => {
    if (projectId) {
      void queryClient.invalidateQueries()
    }
  }, [projectId, teamId])

  async function handleSignOut() {
    // Revoke the server-side session (clears the __Host-rova_session cookie) and return to login.
    // The browser holds no tokens to clear. The POST + clearAuth pair lives in
    // `shared/api/sign-out.ts` because `/accept-invitation` needs the same thing for its
    // wrong-account refusal, and a page cannot import a widget.
    await revokeSession()
    toast.success('Signed out')
    await navigate({ to: '/login' })
  }

  /**
   * Switch the selected project and/or team, landing on Home whenever EITHER changed.
   *
   * Selecting only mutated the store before, so the current route stayed open under a context it no
   * longer belongs to: a work-item detail kept rendering another project's record until something
   * refetched, and a project-scoped page could sit there denied or empty. Home is the one surface that
   * is correct for every context, which is why the BA asked for it.
   *
   * A TEAM-only change navigates too, and this REVERSES the narrower reading shipped earlier — that
   * Team is merely a scope filter, so being thrown to Home would undo the narrowing the reader just
   * asked for. `SHELL-FR-005` states both halves together and admits no such exception: "Khi đổi
   * Project hoặc Team từ context selector, navigate về Home của context mới … Không giữ route hoặc
   * dữ liệu của context cũ." The record routes are why the BA wins: a team-scoped detail or an
   * Iteration Status row belongs to the team that was selected when it was opened, and an Editor
   * moving between their teams would otherwise sit on a record their new scope refuses.
   */
  function selectProjectContext(
    next: { projectId: string; projectKey: string; projectName: string },
    nextTeam: { teamId: string; teamName: string } | null,
  ) {
    const contextChanged =
      project?.projectId !== next.projectId || (team?.teamId ?? null) !== (nextTeam?.teamId ?? null)
    setProject(next)
    setTeam(nextTeam)
    closeAll()
    if (contextChanged) void navigate({ to: '/' })
  }

  function closeAll() {
    setWsOpen(false)
    setUserOpen(false)
    setOpenMenu(null)
    setNotifOpen(false)
  }

  // Close all dropdowns on route change
  useEffect(() => {
    closeAll()
  }, [currentPath])

  // Close all dropdowns on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeAll()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  function handleComingSoon(label: string) {
    closeAll()
    toast.info(`${label} · Coming soon`, {
      description: 'This feature will be available in a future release.',
      duration: 3000,
    })
  }

  // Both live in `shared/config/nav.ts` beside the table they read — see `isNavGroupActive` for why
  // a group's active state cannot be its parent path alone.
  const isActive = (path: string) => isNavPathActive(currentPath, path)
  const isGroupActive = (item: NavItem) => isNavGroupActive(currentPath, item)

  /**
   * Determine nav item visibility:
   *  - Feature disabled → show as "coming soon" (not hidden, per spec)
   *  - Feature enabled + permission required + user lacks it → hide
   *  - Otherwise → show as active link
   *
   * Resolved against the SELECTED PROJECT, not the workspace baseline. Every code these items
   * carry — `work_item:view`, `timebox:view`, `project:view`, `portfolio:view`,
   * `capacity:view`, `report:view` — is project-tier, and a normal user holds them through
   * `work.project_members.access_level`, which reaches the client only via
   * `GET /projects/:id/my-permissions`.
   *
   * `hasPermission` reads the workspace baseline from `/bff/me`, which for a per-Project Admin or
   * Editor is now EMPTY (migration 0111 removed the workspace-scoped tier assignments). Gating on
   * it therefore hid Plan, Track, Quality, Portfolio and Reports from exactly the levels the BA
   * grants them to — the whole delivery surface, for everyone except a Workspace Admin, whose
   * `workspace:*` matched every code and hid the fault from every test.
   *
   * A Workspace Admin is unaffected: `useProjectPermissions` unions the baseline, so `workspace:*`
   * still grants everything with no project selected at all.
   */
  function navItemState(
    item: Pick<NavItem, 'featureFlag' | 'permission'>,
  ): 'coming-soon' | 'hidden' | 'active' {
    if (item.featureFlag && !isFeatureEnabled(item.featureFlag)) return 'coming-soon'
    if (item.permission && !canInProject(item.permission)) return 'hidden'
    return 'active'
  }

  return (
    <div className="flex h-svh flex-col">
      {/* Backdrop to close open dropdowns when clicking outside */}
      {(openMenu !== null || wsOpen || userOpen || notifOpen) && (
        <div className="fixed inset-0 z-20" aria-hidden onClick={closeAll} />
      )}
      {/* ── Top nav ─────────────────────────────────────────────────────────── */}
      <header
        className="relative z-30 flex h-10 shrink-0 items-center bg-primary px-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Logo + workspace selector */}
        <div className="mr-4 flex items-center gap-2">
          {/*
           * The mark is a LINK HOME, which is the one thing a product logo is universally expected
           * to be — it was an inert `div`, so the most-clicked affordance in any web app did
           * nothing. A real `<a>` (TanStack `Link`), never a `div` with an `onClick`: it must carry
           * a focus ring, answer the Enter key and offer open-in-new-tab, and the `fe-consistency`
           * ratchet counts hand-rolled clickable non-buttons for exactly this reason.
           *
           * The name is the static "Home" rather than the workspace's: that string has a three-way
           * fallback ending in `Select workspace`, and an accessible name reading "Select workspace
           * home" would be wrong in precisely the state where the reader needs it to be right.
           */}
          <Link
            to="/"
            aria-label={t('common:homeAria')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}
          >
            <Layers size={13} className="text-white" />
          </Link>
          <div className="relative">
            <button
              onClick={() => {
                const willOpen = !wsOpen
                setWsOpen(willOpen)
                setUserOpen(false)
                setOpenMenu(null)
                if (willOpen) {
                  // Expand the active project so its team is visible; reset the filter.
                  setExpandedProjectId(project?.projectId ?? null)
                  setProjectSearch('')
                }
              }}
              className="flex items-center gap-1.5 text-left text-white hover:opacity-90"
            >
              <div className="leading-tight">
                <div className="text-ui-lg font-semibold">
                  {memberships.find((m) => m.workspaceId === activeWorkspaceId)?.name ??
                    workspace?.workspaceName ??
                    'Select workspace'}
                </div>
                <div
                  className="max-w-44 truncate text-ui-xs"
                  style={{ color: 'rgba(255,255,255,0.55)' }}
                >
                  {project ? `${project.projectKey} · ${selectedTeamName}` : 'No project selected'}
                </div>
              </div>
              <ChevronDown size={10} className="opacity-60" />
            </button>

            {wsOpen && (
              <div className="absolute top-full left-0 mt-1 w-72 overflow-hidden rounded border border-border bg-card py-1.5 shadow-xl">
                {/* Active workspace header */}
                <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-hover px-3 py-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-avatar text-primary">
                    <Layers size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-xs font-semibold tracking-widest text-foreground-subtle uppercase">
                      Workspace
                    </div>
                    <div className="truncate text-ui-lg font-semibold text-foreground">
                      {memberships.find((m) => m.workspaceId === activeWorkspaceId)?.name ??
                        workspace?.workspaceName ??
                        '--'}
                    </div>
                  </div>
                  <span className="rounded-sm bg-success-bg px-1.5 py-0.5 text-ui-xs font-semibold text-success">
                    Active
                  </span>
                </div>

                {/* Single-company MVP: no workspace switcher (COMPANY-FR-010 /
                    SHELL-FR-002). The current workspace is shown above, read-only. */}

                {/* Projects & Teams — searchable, scrollable accordion tree.
                    Each project expands to reveal its teams (lazy-loaded).

                    DELIVERY CONTEXT ONLY. This panel used to end with a divider and a
                    `Manage Projects` link into `/projects`, which made the context switcher a second
                    entrance to project administration; the BA's ruling (GAP-P0-SHELL-007) is that the
                    switcher only changes which project and team the app is pointed at, and that
                    administration is reached solely through the Settings gear's `Workspaces &
                    Projects`. `/projects` keeps its own `project:view` gate either way — see
                    `NON_NAV_SURFACES` in `shared/config/nav.ts` — so nothing here was the thing
                    protecting it.

                    The whole block is conditional now rather than the tree inside it: with the link
                    gone a project-less caller would otherwise get a padded empty panel under the
                    workspace header. */}
                {navProjects.length > 0 && (
                  <div className="px-3 py-2 text-ui-sm text-muted-foreground">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="text-ui-xs font-semibold tracking-widest text-foreground-subtle uppercase">
                        Projects & Teams
                      </div>
                      <span className="text-ui-xs text-foreground-subtle">
                        {navProjects.length}
                      </span>
                    </div>
                    {/* Filter — only worth surfacing once the list gets long */}
                    {navProjects.length > 7 && (
                      <div className="relative mb-1">
                        <Search
                          size={11}
                          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-foreground-subtle"
                        />
                        <input
                          value={projectSearch}
                          onChange={(e) => setProjectSearch(e.target.value)}
                          placeholder="Filter projects…"
                          aria-label="Filter projects"
                          className="w-full rounded border border-border-subtle py-1 pr-2 pl-6 text-ui-sm text-foreground outline-none"
                        />
                      </div>
                    )}
                    <div className="-mx-0.5 max-h-64 overflow-y-auto px-0.5">
                      {filteredNavProjects.map((p) => (
                        <ProjectTreeItem
                          key={p.id}
                          project={p}
                          selected={project?.projectId === p.id}
                          expanded={expandedProjectId === p.id}
                          currentTeamId={team?.teamId ?? null}
                          onToggleExpand={() =>
                            setExpandedProjectId((cur) => (cur === p.id ? null : p.id))
                          }
                          onSelectProject={() =>
                            selectProjectContext(
                              { projectId: p.id, projectKey: p.key, projectName: p.name },
                              null,
                            )
                          }
                          onSelectTeam={(t) =>
                            selectProjectContext(
                              { projectId: p.id, projectKey: p.key, projectName: p.name },
                              t ? { teamId: t.id, teamName: t.name } : null,
                            )
                          }
                        />
                      ))}
                      {filteredNavProjects.length === 0 && (
                        <div className="px-1.5 py-2 text-center text-ui-xs text-foreground-subtle">
                          No projects match “{projectSearch.trim()}”
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Primary nav */}
        <nav className="flex flex-1 items-center gap-0.5">
          {NAV_ITEMS.map((item) => {
            const { path, label, children, featureFlag, permission } = item
            const state = navItemState({ featureFlag, permission })
            if (state === 'hidden') return null

            const comingSoon = state === 'coming-soon'

            if (children) {
              /**
               * A dropdown whose every CHILD is hidden must not render at all.
               *
               * The Portfolio menu is the live case: its trigger carries `project:view`, which every
               * access level holds, while all three children carry codes an Editor does not
               * (`portfolio:view`, `capacity:view`, `report:view`). So an Editor saw a `Portfolio`
               * menu, clicked it, and got an empty panel — the surface announced as existing and then
               * offering nothing. A parent is a route to its children; with none visible it is not a
               * route to anywhere.
               *
               * The BA is SILENT on this case, so it is a declared decision rather than a rule: their
               * own mockup filters the nav per role (`03_Mockup Design/src/app/components/layout.tsx`)
               * and simply has no persona for whom a parent outlives its children.
               *
               * `coming-soon` children still count as visible: that state is deliberately shown, not
               * hidden (a flag-disabled feature announces itself), so a menu holding only those is
               * still a menu with contents.
               */
              const visibleChildren = children.filter((child) => navItemState(child) !== 'hidden')
              if (visibleChildren.length === 0) return null

              return (
                // Plan dropdown
                <div key={label} className="relative">
                  <button
                    aria-haspopup="menu"
                    aria-expanded={openMenu === label}
                    onClick={() => {
                      if (comingSoon) {
                        handleComingSoon(label)
                        return
                      }
                      // Toggle dropdown — never auto-navigate. User picks a child.
                      setOpenMenu((cur) => (cur === label ? null : label))
                      setWsOpen(false)
                      setUserOpen(false)
                    }}
                    className="flex items-center gap-1.5 rounded py-1 pr-2 pl-2.5 text-ui-lg font-medium transition-colors"
                    style={{
                      backgroundColor: isGroupActive(item)
                        ? 'rgba(255,255,255,0.16)'
                        : 'transparent',
                      color: isGroupActive(item) ? BRAND.surface : 'rgba(255,255,255,0.72)',
                    }}
                  >
                    {label}
                    {comingSoon ? (
                      <span
                        className="ml-0.5 rounded-sm px-1 py-px text-ui-xs font-semibold tracking-wide uppercase"
                        style={{
                          backgroundColor: 'rgba(255,255,255,0.12)',
                          color: 'rgba(255,255,255,0.5)',
                        }}
                      >
                        Soon
                      </span>
                    ) : (
                      <ChevronDown
                        size={9}
                        style={{
                          color: isGroupActive(item) ? BRAND.surface : 'rgba(255,255,255,0.55)',
                          transform: openMenu === label ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.15s',
                        }}
                      />
                    )}
                  </button>
                  {!comingSoon && openMenu === label && (
                    <div className="absolute top-full left-0 z-50 mt-1 w-44 rounded border border-border bg-card py-1 shadow-lg">
                      <div className="px-3 py-1.5 text-ui-xs font-semibold tracking-widest text-foreground-subtle uppercase">
                        {label}
                      </div>
                      {visibleChildren.map((child) => {
                        const childState = navItemState(child)
                        if (childState === 'hidden') return null
                        const childComingSoon = childState === 'coming-soon'
                        if (childComingSoon) {
                          return (
                            <button
                              key={child.path}
                              onClick={() => handleComingSoon(child.label)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui-lg text-foreground"
                            >
                              <span className="flex-1">{child.label}</span>
                              <span className="rounded-sm bg-border-inner px-1 py-px text-ui-xs font-semibold tracking-wide text-foreground-subtle uppercase">
                                Soon
                              </span>
                            </button>
                          )
                        }
                        return (
                          <Link
                            key={child.path}
                            to={child.path}
                            onClick={() => setOpenMenu(null)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui-lg"
                            style={{
                              color: isActive(child.path) ? BRAND.primary : BRAND.textPrimary,
                              backgroundColor: isActive(child.path)
                                ? BRAND.primaryLighter
                                : 'transparent',
                              fontWeight: isActive(child.path) ? 600 : 400,
                            }}
                          >
                            <span className="flex-1">{child.label}</span>
                          </Link>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            }

            if (comingSoon) {
              return (
                <button
                  key={path}
                  onClick={() => handleComingSoon(label)}
                  className="flex items-center rounded px-2.5 py-1 text-ui-lg font-medium transition-colors"
                  style={{ color: 'rgba(255,255,255,0.55)' }}
                >
                  {label}
                  <span
                    className="rounded-sm px-1 py-px text-ui-xs font-semibold tracking-wide uppercase"
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.10)',
                      color: 'rgba(255,255,255,0.45)',
                    }}
                  >
                    Soon
                  </span>
                </button>
              )
            }

            return (
              <Link
                key={path}
                to={path as '/'}
                onClick={closeAll}
                className="flex items-center rounded px-2.5 py-1 text-ui-lg font-medium transition-colors"
                style={{
                  backgroundColor: isActive(path) ? 'rgba(255,255,255,0.16)' : 'transparent',
                  color: isActive(path) ? BRAND.surface : 'rgba(255,255,255,0.72)',
                }}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Right controls */}
        <div className="flex items-center gap-1">
          <GlobalSearch />

          {/* Notifications — click to open popover; Shift+click goes to full page */}
          <div className="relative">
            <button
              aria-label="Notifications"
              aria-haspopup="dialog"
              aria-expanded={notifOpen}
              onClick={() => {
                setNotifOpen((o) => !o)
                setWsOpen(false)
                setUserOpen(false)
                setOpenMenu(null)
              }}
              className="relative rounded p-1.5 transition-colors"
              style={{
                color: notifOpen ? BRAND.surface : 'rgba(255,255,255,0.65)',
                backgroundColor: notifOpen ? 'rgba(255,255,255,0.16)' : 'transparent',
              }}
            >
              <Bell size={14} />
              {unreadCount > 0 && (
                <span className="absolute top-0.5 right-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-destructive px-0.5 text-ui-xs leading-none font-bold text-white">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            <NotificationPopover open={notifOpen} onClose={() => setNotifOpen(false)} />
          </div>

          {/* Help */}
          <button
            className="rounded p-1.5"
            style={{ color: 'rgba(255,255,255,0.65)' }}
            aria-label="Help"
            onClick={() => toast.info('Help & documentation coming soon', { duration: 2500 })}
          >
            <HelpCircle size={14} />
          </button>

          {/* Settings */}
          <Link
            to={'/settings' as '/'}
            className="rounded p-1.5"
            style={{ color: isActive('/settings') ? BRAND.surface : 'rgba(255,255,255,0.65)' }}
            onClick={closeAll}
          >
            <Settings size={14} />
          </Link>

          {/* User menu */}
          <div className="relative ml-1">
            <button
              onClick={() => {
                setUserOpen((o) => !o)
                setWsOpen(false)
                setOpenMenu(null)
              }}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:opacity-90"
              style={{ color: 'rgba(255,255,255,0.85)' }}
            >
              <Avatar name={user?.displayName ?? 'U'} size={24} />
              <ChevronDown size={9} className="opacity-60" />
            </button>

            {userOpen && (
              <div className="absolute top-full right-0 z-50 mt-1 w-56 overflow-hidden rounded border border-border bg-card shadow-xl">
                {/* Profile info */}
                <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-hover px-3 py-3">
                  <Avatar name={user?.displayName ?? 'U'} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui-md font-semibold text-foreground">
                      {user?.displayName}
                    </div>
                    <div className="truncate text-ui-xs text-foreground-subtle">{user?.email}</div>
                  </div>
                </div>

                {/* Menu items */}
                <div className="py-1">
                  <Link
                    to={'/settings' as '/'}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-ui-sm text-foreground hover:bg-surface-subtle"
                    onClick={closeAll}
                  >
                    <User size={13} className="text-muted-foreground" />
                    My profile
                  </Link>
                  <Link
                    to={'/settings' as '/'}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-ui-sm text-foreground hover:bg-surface-subtle"
                    onClick={closeAll}
                  >
                    <Settings size={13} className="text-muted-foreground" />
                    Settings
                  </Link>
                </div>

                <div className="border-t border-border-subtle py-1">
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-ui-sm text-destructive hover:bg-destructive-bg"
                  >
                    <LogOut size={13} />
                    {t('signOut')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Breadcrumb bar ───────────────────────────────────────────────────── */}
      {crumbs.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-card px-4 text-ui-sm">
          {crumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <ChevronRight size={11} className="text-foreground-faint" />
              <span
                style={{
                  color: i === crumbs.length - 1 ? BRAND.textPrimary : BRAND.textSecondary,
                  fontWeight: i === crumbs.length - 1 ? 600 : 400,
                }}
              >
                {crumb}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* ── Page content ─────────────────────────────────────────────────────── */}
      <main
        id="main-content"
        className="flex min-h-0 flex-1 flex-col overflow-auto bg-background"
        aria-label="Main content"
      >
        <PageErrorBoundary>
          <Outlet />
        </PageErrorBoundary>
      </main>
    </div>
  )
}
