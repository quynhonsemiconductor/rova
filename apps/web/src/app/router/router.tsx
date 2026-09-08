import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'
import type { QueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { bootstrapAuth } from '@/shared/api/auth-bootstrap'
import { STORAGE_KEYS } from '@/shared/config/storage-keys'

// ── Extend staticData for breadcrumb support (SHELL-FR-007) ──────────────────
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    breadcrumb?: string
    /** Top-nav section this route belongs to (e.g. 'Track'), rendered in the breadcrumb. */
    section?: string
  }
}

// ── Router context type ───────────────────────────────────────────────────────
export interface RouterContext {
  queryClient: QueryClient
}

// ── Root route ────────────────────────────────────────────────────────────────
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </>
  ),
})

// ── Auth guard helper ─────────────────────────────────────────────────────────
async function requireAuth() {
  await bootstrapAuth()
  const { isAuthenticated } = useAuthStore.getState()
  if (!isAuthenticated) {
    // AUTH-FR-012: preserve requested URL so login can redirect back after session expiry
    const returnTo = window.location.pathname + window.location.search
    const search =
      returnTo && returnTo !== '/' && !returnTo.startsWith('/login') ? { returnTo } : undefined
    throw redirect({ to: '/login', search } as Parameters<typeof redirect>[0])
  }
}

// ── Lazy component helper ─────────────────────────────────────────────────────
// Each page is a separate chunk — only the shell is always loaded.
import { lazy, Suspense } from 'react'
import { PageSpinner } from '@/shared/ui/spinner'
import { RequirePermission } from '@/features/access/ui/require-permission'
import { navPermissionFor } from '@/shared/config/nav'

function lazyPage<T extends Record<string, React.ComponentType>>(
  factory: () => Promise<T>,
  key: keyof T,
) {
  const Lazy = lazy(() => factory().then((m) => ({ default: m[key] as React.ComponentType })))
  return () => (
    <Suspense fallback={<PageSpinner />}>
      <Lazy />
    </Suspense>
  )
}

/**
 * `lazyPage`, plus the permission the NAV gates the same path on.
 *
 * The code is looked up from `shared/config/nav.ts` by path rather than passed in, so this file
 * cannot state a code at all — nav-hidden and route-open are then incapable of disagreeing, which
 * was the whole defect: a bookmarked `/portfolio` rendered the page for a caller whose nav did not
 * offer it, and the page's scoped query answered with nothing, so the grid read "this project has no
 * Features". Phase 4 `02_Roles_Permissions/SRS.md:197` requires Access Denied there.
 *
 * `test/route-permission.contract.test.tsx` is what makes the pairing hold: it asserts every
 * permission-carrying nav path routes through `guardedPage` with that same path literal, so a new
 * surface added with plain `lazyPage`, or a mistyped path (which would silently resolve to
 * `undefined` and gate nothing), fails there rather than in production.
 *
 * UX ONLY — `PolicyGuard` on the API is the authorization boundary and refuses independently. See
 * `features/access/ui/require-permission.tsx` for why this is a component and not a `beforeLoad`.
 */
function guardedPage<T extends Record<string, React.ComponentType>>(
  path: string,
  factory: () => Promise<T>,
  key: keyof T,
) {
  const Page = lazyPage(factory, key)
  return () => (
    <RequirePermission code={navPermissionFor(path)}>
      <Page />
    </RequirePermission>
  )
}

// ── Deep-link project adoption ────────────────────────────────────────────────
// A deep link is a property of the ROUTE, so "which project does this record belong to" is resolved
// here — not on whatever clicked it. That switch used to live in `useOpenNotification`, i.e. on the
// notification CLICK handler, so an in-app click landed in the right project context and the very
// same URL pasted into a chat did not. One code path now serves both, and it runs before the first
// paint, so the shell's breadcrumb and project selector never flicker through the previous project.
//
// Both adopters are imported dynamically: everything at this file's top level is in the shell
// bundle, and each page is deliberately its own chunk. The page's chunk imports the same feature
// module, so the loader shares it rather than duplicating it.
//
// ORDERING vs. THE GUARD — verified, not assumed
// `RequirePermission` resolves permissions for the SELECTED project, so a record route that both
// adopts a project AND is guarded has to adopt FIRST: a deep link denied on the permissions of the
// project the reader happened to have selected before would be a worse defect than the unguarded
// route it replaces. It does. TanStack Router holds a match at `status: 'pending'` until its loader
// promise resolves and `Match` SUSPENDS on `loadPromise` while pending, so the component is not
// rendered at all until the loader has returned (`router-core`'s `runLoader`: `await loaderResult`,
// then `status: 'success'`). `adoptRecordProject` calls `setProject` synchronously after its own
// await, so the adopted project is in the store on the guard's FIRST render.
//
// The residue, stated because it is not nothing: when the record cannot be resolved the loader
// swallows the failure and adopts nothing, so the guard decides in the reader's currently selected
// project. A 403 has already redirected to `/403`; a 404 leaves a caller who cannot open that surface
// here with Access Denied rather than Not Found for an id that was never resolved — which discloses
// nothing, since nothing was looked up. `/portfolio/$itemId`, `/capacity-planning/$planId` and
// `/milestones/$milestoneId` have no adopter at all, so their guard and their page read the one
// selected project and are incapable of disagreeing.

// ── Public routes ─────────────────────────────────────────────────────────────
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: lazyPage(() => import('@/pages/login/login-page'), 'LoginPage'),
})

// ── Authenticated layout route ────────────────────────────────────────────────
const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  beforeLoad: requireAuth,
  component: lazyPage(() => import('@/widgets/app-shell/app-shell'), 'AppShell'),
})

// ── App routes (children of auth layout) ─────────────────────────────────────
const homeRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/',
  staticData: { breadcrumb: 'Home' },
  component: lazyPage(() => import('@/pages/home/home-page'), 'HomePage'),
})

// The Projects list is not a top-nav row — it opens from Settings > Workspaces & Projects — so its
// code comes from `NON_NAV_SURFACES` rather than a nav entry. (Until GAP-P0-SHELL-007 it also had a
// `Manage Projects` link in the Project/Team switcher; that dropdown may only change delivery
// context, so the gear is now the only doorway.) §3.1:67 ("View `Workspaces & Projects`") is Hidden
// only for No Access, so `project:view` is the code, and the pair below is the whole reason it needed
// one: a record route folds onto its list surface, and this list had nothing to fold.
const projectsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/projects',
  staticData: { breadcrumb: 'Manage Projects' },
  component: guardedPage(
    '/projects',
    () => import('@/pages/projects/projects-page'),
    'ProjectsPage',
  ),
})

const projectDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/projects/$projectKey',
  staticData: { breadcrumb: 'Project Detail' },
  component: guardedPage(
    '/projects/$projectKey',
    () => import('@/pages/projects/projects-detail-page'),
    'ProjectDetailPage',
  ),
})

const settingsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/settings',
  staticData: { breadcrumb: 'Settings' },
  component: lazyPage(() => import('@/pages/settings/settings-page'), 'SettingsPage'),
})

const notificationsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/notifications',
  staticData: { breadcrumb: 'Notifications' },
  component: lazyPage(
    () => import('@/pages/notifications/notifications-page'),
    'NotificationsPage',
  ),
})

// The target of the invitation email's link — `${APP_BASE_URL}/accept-invitation?token=<raw token>`,
// which `WorkspaceService.inviteMember` has always sent to a route that did not exist, so every
// invitation landed on `notFoundRoute` and `POST /v1/invitations/accept` was never called by anything.
//
// A CHILD OF `authRoute`, and that placement is the whole sign-in-then-accept design: acceptance needs
// an authenticated caller (the API binds it to the signed-in user's email), and `requireAuth` above
// already redirects to `/login` with `returnTo = pathname + search`, so `?token=` survives the round
// trip and the BFF callback returns here.
//
// `lazyPage`, NOT `guardedPage`: no permission code, and no entry in `NON_NAV_SURFACES`. Any
// authenticated caller may open it, the authority that matters is the token plus the email binding
// (both server-side), and a fresh member holds nothing yet — so gating this on a code would deny the
// very population the link is for. Same shape as `/`, `/settings` and `/notifications`.
const acceptInvitationRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/accept-invitation',
  staticData: { breadcrumb: 'Accept Invitation' },
  component: lazyPage(
    () => import('@/pages/accept-invitation/accept-invitation-page'),
    'AcceptInvitationPage',
  ),
})

const forbiddenRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/403',
  staticData: { breadcrumb: 'Access Denied' },
  component: lazyPage(() => import('@/pages/forbidden/forbidden-page'), 'ForbiddenPage'),
})

// ── Phase 1: Plan ─────────────────────────────────────────────────────────────

const backlogRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/backlog',
  staticData: { breadcrumb: 'Backlog' },
  component: guardedPage('/backlog', () => import('@/pages/backlog/backlog-page'), 'BacklogPage'),
})

const workItemDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/item/$itemKey',
  staticData: { breadcrumb: 'Work Item' },
  // A shared link must open in the ITEM's project, not the recipient's last-selected one.
  // `cause` is threaded on purpose: `defaultPreload: 'intent'` runs this loader on HOVER, and the
  // adopter writes global state. Global search links here for any typed key, so a hover used to
  // switch project silently. See `adoptRecordProject`.
  loader: ({ context, params, cause }) =>
    import('@/features/work-items/deep-link').then((m) =>
      m.adoptWorkItemProject(context.queryClient, params.itemKey, cause),
    ),
  // Gated on the code its LIST surfaces carry (`work_item:view`), which the alias table folds onto
  // this path — see there for why a surface code on a record route is §197 and not §198. The loader
  // above has already adopted the item's project by the time this renders.
  component: guardedPage(
    '/item/$itemKey',
    () => import('@/pages/work-item/work-item-detail-page'),
    'WorkItemDetailPage',
  ),
})

const testCaseDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/test-case/$testCaseKey',
  staticData: { breadcrumb: 'Test Case' },
  // Same reasoning as `/item/$itemKey` — Test Case keys are workspace-unique, so the project is
  // unknown until the row loads.
  loader: ({ context, params, cause }) =>
    import('@/features/test-cases/deep-link').then((m) =>
      m.adoptTestCaseProject(context.queryClient, params.testCaseKey, cause),
    ),
  // Plain `lazyPage`, NOT `guardedPage`: Test Case Detail is reached only from the tab's ID link
  // (no nav row, no list surface of its own to fold a code onto), so the PAGE owns its whole denied
  // state — 403/404/other, the same three-outcome shape `/item/$itemKey`'s `WorkItemUnavailable`
  // uses (CLAUDE.md: "A record route must own its denied state; its guard cannot").
  component: lazyPage(
    () => import('@/pages/test-case/test-case-detail-page'),
    'TestCaseDetailPage',
  ),
})

const testResultDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/test-result/$testResultId',
  staticData: { breadcrumb: 'Test Result' },
  // Test Results have no `by-key` server route (plan §3 lists only `GET /test-results/:id`), so
  // this resolves by UUID, unlike `/test-case/$testCaseKey`'s workspace-unique key.
  loader: ({ context, params, cause }) =>
    import('@/features/test-cases/deep-link-result').then((m) =>
      m.adoptTestResultProject(context.queryClient, params.testResultId, cause),
    ),
  // Same THIRD shape as `/test-case/$testCaseKey`: reached only from the Results tab's Build-cell
  // link (no nav row, no list surface of its own to fold a code onto), so the PAGE owns its whole
  // denied state — 403/404/other (CLAUDE.md: "A record route must own its denied state").
  component: lazyPage(
    () => import('@/pages/test-result/test-result-detail-page'),
    'TestResultDetailPage',
  ),
})

const timeboxesRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/timeboxes',
  staticData: { breadcrumb: 'Timeboxes' },
  component: guardedPage(
    '/timeboxes',
    () => import('@/pages/iterations/iterations-page'),
    'IterationsPage',
  ),
})

const iterationDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/timeboxes/$iterationId',
  staticData: { breadcrumb: 'Iteration Detail' },
  // A record of the Timeboxes surface, so it carries `timebox:view` like the list modes and the
  // Release/Milestone records do. It was page-local state until now, which is why it is new here
  // rather than having always been guarded.
  component: guardedPage(
    '/timeboxes/$iterationId',
    () => import('@/pages/iterations/iteration-detail-page'),
    'IterationDetailPage',
  ),
})

const iterationStatusRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/iteration-status',
  staticData: { breadcrumb: 'Iteration Status', section: 'Track' },
  component: guardedPage(
    '/iteration-status',
    () => import('@/pages/iteration-status/iteration-status-page'),
    'IterationStatusPage',
  ),
})

const releasesRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/releases',
  // A TYPE mode of the Timeboxes screen, not its own top-level surface — the
  // mockup breadcrumb reads "… › Plan › Timeboxes" here (DEV-004).
  staticData: { breadcrumb: 'Timeboxes' },
  component: guardedPage(
    '/releases',
    () => import('@/pages/releases/releases-page'),
    'ReleasesPage',
  ),
})

const releaseDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/releases/$releaseId',
  staticData: { breadcrumb: 'Release Detail' },
  // A shared link must open in the RELEASE's project, not the recipient's last-selected one.
  // `cause` threaded for the same reason as `/item/$itemKey` above — a hover-time preload must not
  // move the selected project.
  loader: ({ context, params, cause }) =>
    import('@/features/releases/deep-link').then((m) =>
      m.adoptReleaseProject(context.queryClient, params.releaseId, cause),
    ),
  // A record of the Timeboxes surface, so it carries `timebox:view` like the three list modes do.
  // Unguarded, a caller the nav denies `/timeboxes` to could paste a release URL and get the record.
  component: guardedPage(
    '/releases/$releaseId',
    () => import('@/pages/releases/releases-detail-page'),
    'ReleaseDetailPage',
  ),
})

const milestonesRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/milestones',
  // A TYPE mode of the Timeboxes screen (see /releases above).
  staticData: { breadcrumb: 'Timeboxes' },
  component: guardedPage(
    '/milestones',
    () => import('@/pages/milestones/milestones-page'),
    'MilestonesPage',
  ),
})

const milestoneDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/milestones/$milestoneId',
  staticData: { breadcrumb: 'Milestone Detail' },
  // Timeboxes again: §3.2:83 hides "Releases and Milestones" in the same row as Timeboxes.
  component: guardedPage(
    '/milestones/$milestoneId',
    () => import('@/pages/milestones/milestones-detail-page'),
    'MilestoneDetailPage',
  ),
})

const qualityRedirectRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/quality',
  beforeLoad: () => {
    throw redirect({ to: '/quality/defects' })
  },
})

const qualityDefectsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/quality/defects',
  staticData: { breadcrumb: 'Quality' },
  component: guardedPage(
    '/quality/defects',
    () => import('@/pages/quality/quality-page'),
    'QualityPage',
  ),
})

const teamStatusRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/team-status',
  staticData: { breadcrumb: 'Team Status', section: 'Track' },
  component: guardedPage(
    '/team-status',
    () => import('@/pages/team-status/team-status-page'),
    'TeamStatusPage',
  ),
})

// Team Board was consolidated into the Iteration Status List/Board toggle — the
// BA design has no separate board screen, and both surfaces render the same
// iteration read-model via the shared IterationBoard widget. The old URL is
// preserved as a redirect that lands on Iteration Status in Board mode.
const teamBoardRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/team-board',
  beforeLoad: () => {
    try {
      localStorage.setItem(STORAGE_KEYS.ITERATION_STATUS_VIEW_MODE, 'board')
    } catch {
      // localStorage unavailable (e.g. private mode) — Iteration Status will
      // simply open in its default (list) view.
    }
    throw redirect({ to: '/iteration-status' })
  },
})

const portfolioRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/portfolio',
  staticData: { breadcrumb: 'Portfolio' },
  component: guardedPage(
    '/portfolio',
    () => import('@/pages/portfolio/portfolio-page'),
    'PortfolioPage',
  ),
})

const portfolioDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/portfolio/$itemId',
  staticData: { breadcrumb: 'Portfolio Item' },
  // `portfolio:view` — the LEAF's code, not the Portfolio menu trigger's `project:view`, which every
  // access level holds. §5 makes Portfolio Items an admin surface, so an Editor pasting a Feature URL
  // is exactly the reader this denies.
  component: guardedPage(
    '/portfolio/$itemId',
    () => import('@/pages/portfolio/portfolio-detail-page'),
    'PortfolioDetailPage',
  ),
})

const capacityPlansRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/capacity-planning',
  staticData: { breadcrumb: 'Capacity Planning' },
  component: guardedPage(
    '/capacity-planning',
    () => import('@/pages/capacity-planning/capacity-plans-page'),
    'CapacityPlansPage',
  ),
})

const capacityPlanDetailRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/capacity-planning/$planId',
  staticData: { breadcrumb: 'Capacity Plan' },
  // `capacity:view`. P5-CAP-AC-010: "Editor/No Access do not access Capacity Planning" — a plan URL
  // must not be the way around that.
  component: guardedPage(
    '/capacity-planning/$planId',
    () => import('@/pages/capacity-planning/capacity-plan-detail-page'),
    'CapacityPlanDetailPage',
  ),
})

// `Portfolio > Release Tracking`, the third item in the Portfolio menu (RT-AC-01). Its own page
// rather than a card inside Reports: the SRS moved it out of Reports deliberately, and it tracks a
// Release rather than an iteration.
const releaseTrackingRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/release-tracking',
  staticData: { breadcrumb: 'Release Tracking' },
  component: guardedPage(
    '/release-tracking',
    () => import('@/pages/release-tracking/release-tracking-page'),
    'ReleaseTrackingPage',
  ),
})

const reportsRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '/reports',
  staticData: { breadcrumb: 'Reports' },
  component: guardedPage('/reports', () => import('@/pages/reports/reports-page'), 'ReportsPage'),
})

// ── Not found ─────────────────────────────────────────────────────────────────

const notFoundRoute = createRoute({
  getParentRoute: () => authRoute,
  path: '$',
  staticData: { breadcrumb: 'Not Found' },
  component: lazyPage(() => import('@/pages/not-found/not-found-page'), 'NotFoundPage'),
})

// ── Route tree ────────────────────────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  loginRoute,
  authRoute.addChildren([
    homeRoute,
    projectsRoute,
    projectDetailRoute,
    settingsRoute,
    notificationsRoute,
    acceptInvitationRoute,
    forbiddenRoute,
    backlogRoute,
    timeboxesRoute,
    iterationDetailRoute,
    iterationStatusRoute,
    releasesRoute,
    releaseDetailRoute,
    milestonesRoute,
    milestoneDetailRoute,
    qualityRedirectRoute,
    qualityDefectsRoute,
    teamStatusRoute,
    teamBoardRoute,
    reportsRoute,
    portfolioRoute,
    portfolioDetailRoute,
    capacityPlansRoute,
    capacityPlanDetailRoute,
    releaseTrackingRoute,
    workItemDetailRoute,
    testCaseDetailRoute,
    testResultDetailRoute,
    notFoundRoute,
  ]),
])

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined! }, // injected in App.tsx
  defaultPreload: 'intent', // prefetch route chunks + loaders on link hover
})

// Type-safe router registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
