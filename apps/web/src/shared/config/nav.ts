/**
 * The top-nav table — and, derived from the SAME rows, the path → permission map the ROUTER gates on.
 *
 * Two small tables extend the derivation without duplicating a code: {@link NAV_PATH_ALIASES} for a
 * path that is another entry into a nav surface, and {@link NON_NAV_SURFACES} for a surface the nav
 * does not offer at all. Both resolve to a code stated exactly once.
 *
 * The defect this file exists to close
 * ------------------------------------
 * The nav hid an item the caller lacked the permission for (`navItemState` in
 * `widgets/app-shell/app-shell.tsx`), and the router carried NO permission check at all — routes
 * only required authentication. So `/portfolio` typed, bookmarked or pasted rendered the page for a
 * caller whose nav did not offer it. That was harmless only while the server over-granted; with the
 * per-project access model in force, a project Editor's Portfolio request now legitimately returns
 * nothing, so the surface rendered an EMPTY GRID — which reads as "this project has no Features"
 * rather than "you cannot see this". Phase 4 `02_Roles_Permissions/SRS.md:197`: "A known route
 * without sufficient action permission shows Access Denied." (§198's Not-Found masking is for a
 * specific record id whose existence is sensitive; a top-level surface's absence from the nav
 * already discloses nothing, so Access Denied is the correct state here. The RECORD routes are gated
 * on their surface's code too, and why that is not §198's case is argued at {@link NAV_PATH_ALIASES}.)
 *
 * It lives in `shared/config` rather than in the widget so that BOTH readers can have it: the shell
 * is a `widgets/` module and the router is `app/`, and while `app → widgets` is a legal FSD edge, a
 * nav TABLE is configuration, not shell internals. The one thing that must never happen again is a
 * second copy of these codes: nav-hidden and route-open can only disagree if the pairing is written
 * down twice.
 *
 * UX ONLY. The server is the authorization boundary and already refuses these requests — see
 * `PolicyGuard` and `AccessService.listReadableProjectIds`. Nothing here is a security control; it
 * stops a bookmark from rendering an empty grid that reads as data.
 */

import { PERMISSION } from '@/shared/config/permissions'

export interface SubNavItem {
  path: string
  label: string
  permission?: string
  featureFlag?: string
}

export interface NavItem {
  path: string
  label: string
  /** Permission code required to see this nav item. Undefined = any authenticated user. */
  permission?: string
  /** Feature flag key. When false this feature is not yet built; shows as "coming soon". */
  featureFlag?: string
  children?: SubNavItem[]
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Home' },
  {
    path: '/backlog',
    label: 'Plan',
    featureFlag: 'feature.backlog',
    permission: PERMISSION.WORK_ITEM_VIEW,
    children: [
      {
        path: '/backlog',
        label: 'Backlog',
        featureFlag: 'feature.backlog',
        permission: PERMISSION.WORK_ITEM_VIEW,
      },
      {
        // Releases and Milestones are NOT separate Plan entries — they are TYPE
        // modes inside this one Timeboxes screen, reached via its TYPE dropdown
        // (TimeboxTypeSwitcher). Matches the BA mockup and DEV_HANDOFF.md
        // ("Release management remains under Plan > Timeboxes"). Was gap DEV-004.
        path: '/timeboxes',
        label: 'Timeboxes',
        featureFlag: 'feature.timeboxes',
        // `timebox:view`, NOT `iteration:view`. §3.2 marks `Plan > Timeboxes` Hidden for
        // an Editor, but every level holds `iteration:view` (Iteration Status, the Backlog
        // filter and Team Status all read the iteration list), so gating on it rendered the
        // entry for a level the BA hides — and its Releases/Milestones modes then 403'd.
        permission: PERMISSION.TIMEBOX_VIEW,
      },
    ],
  },
  {
    path: '/iteration-status',
    label: 'Track',
    featureFlag: 'feature.iteration-status',
    permission: PERMISSION.WORK_ITEM_VIEW,
    children: [
      {
        path: '/iteration-status',
        label: 'Iteration Status',
        featureFlag: 'feature.iteration-status',
        permission: PERMISSION.WORK_ITEM_VIEW,
      },
      {
        path: '/team-status',
        label: 'Team Status',
        featureFlag: 'feature.team-status',
        permission: PERMISSION.WORK_ITEM_VIEW,
      },
    ],
  },
  {
    path: '/quality/defects',
    label: 'Quality',
    featureFlag: 'feature.quality',
    permission: PERMISSION.WORK_ITEM_VIEW,
    children: [
      {
        path: '/quality/defects',
        label: 'Defects',
        featureFlag: 'feature.quality',
        permission: PERMISSION.WORK_ITEM_VIEW,
      },
    ],
  },
  {
    path: '/portfolio',
    label: 'Portfolio',
    featureFlag: 'feature.portfolio',
    permission: PERMISSION.PROJECT_VIEW,
    // SoT §4: Portfolio is a dropdown. Through Phase 4 its only child was a
    // "Release Planning" placeholder pointing at /portfolio; Phase 5 fills both
    // surfaces in, so the placeholder becomes two real entries. Real Release
    // MANAGEMENT still lives under Plan > Timeboxes > Releases — this dropdown is
    // portfolio items and capacity.
    //
    // RALLY PARITY (corrects an earlier note in this file)
    // Rally: has BOTH pages, and they are different products. "Capacity Planning"
    // is its own page under Portfolio — "Select Portfolio, Capacity Planning" — with
    // a plan object, a draft/published lifecycle and per-team allocations. "Release
    // Planning" is a separate board under Planning (backlog column + release columns,
    // drag a card to schedule); it has no plan object and no lifecycle.
    // https://techdocs.broadcom.com/us/en/ca-enterprise-software/valueops/rally/rally-help/planning/capacity-planning-page/creating-a-capacity-plan/create-a-capacity-plan.html
    // Our Capacity Planning maps to Rally's Capacity Planning, NOT to Release
    // Planning. The previous note here claimed the opposite and was wrong; it sent a
    // research pass down a false trail before being caught.
    // Decided 2026-08-04. See 09_Gap_Audit/PHASE_5_6_DECISION_MATRIX.md#P5-CP-1
    children: [
      {
        // "Portfolio Items", not "Portfolio": a child repeating its parent's label reads as a
        // link back to the menu, and the page lists Epics and Features — items.
        path: '/portfolio',
        label: 'Portfolio Items',
        featureFlag: 'feature.portfolio',
        permission: PERMISSION.PORTFOLIO_VIEW,
      },
      {
        path: '/capacity-planning',
        label: 'Capacity Planning',
        featureFlag: 'feature.portfolio',
        permission: PERMISSION.CAPACITY_VIEW,
      },
      {
        // Third and LAST in the Portfolio menu (RT-AC-01), which is where the SRS puts it.
        path: '/release-tracking',
        label: 'Release Tracking',
        featureFlag: 'feature.release-tracking',
        permission: PERMISSION.REPORT_VIEW,
      },
    ],
  },
  {
    path: '/reports',
    label: 'Reports',
    featureFlag: 'feature.reports',
    permission: PERMISSION.REPORT_VIEW,
  },
]

/**
 * path → permission code, flattened from {@link NAV_ITEMS}. **A CHILD OVERRIDES ITS PARENT.**
 *
 * A parent row's `path` is only the dropdown's default destination, so where the two disagree the
 * LEAF is the row that describes the surface. `/portfolio` is the live case: the Portfolio menu
 * trigger carries `project:view` (held by every access level, so the menu itself stays visible),
 * while `Portfolio Items` carries `portfolio:view`. Reading the parent would have guarded the route
 * with a code an Editor holds and left the empty grid exactly as it was.
 *
 * A path with no permission on either row is absent from this map, and that is a real answer:
 * `/` (Home) is open to any authenticated caller.
 */
/**
 * Paths that are ANOTHER ENTRY INTO A NAV SURFACE rather than surfaces of their own.
 *
 * Deriving the map from {@link NAV_ITEMS} alone leaves a hole exactly where the nav is a Type
 * SWITCH: `Plan > Timeboxes` is one screen with three modes, and only the Iterations mode owns the
 * nav row. `/releases` and `/milestones` say so themselves — both carry
 * `staticData.breadcrumb: 'Timeboxes'` in `router.tsx` — so a caller the nav denies `/timeboxes` to
 * could bookmark `/releases` and render the same surface, which is the whole defect this map exists
 * to close. §3.2:83 puts "Releases and Milestones" Hidden for an Editor in the same row as
 * Timeboxes, so one code covers all three.
 *
 * THE RECORD ROUTES BELONG HERE, AND LEAVING THEM OUT WAS WRONG
 * -------------------------------------------------------------
 * `/portfolio/$itemId`, `/capacity-planning/$planId`, `/releases/$releaseId`,
 * `/milestones/$milestoneId` and `/item/$itemKey` were deliberately excluded, with a spec assertion
 * recording the exclusion, on the grounds that §198 lets "a missing item, inaccessible Project or
 * guessed identifier" show Not Found and that Access Denied on a SPECIFIC id discloses that the id
 * EXISTS. That reasoning does not survive contact with what is actually being gated here, which is a
 * SURFACE code and nothing narrower: the guard denies `/portfolio/<anything>` to a caller without
 * `portfolio:view` and gives the SAME answer for a real id and for a fabricated one, because it never
 * looks at the id — the decision is reached without loading the row. So it discloses nothing about
 * any id, §197 governs it ("A known route without sufficient action permission shows Access Denied"),
 * and §199 is satisfied because the denial renders no record data at all. Unguarded, these paths were
 * the whole bookmark defect with an id on the end: a caller the nav denies `/portfolio` to could
 * paste a Feature URL and get the record surface.
 *
 * §198's case is a DIFFERENT one, and this guard neither decides it nor may pretend to: a caller who
 * HOLDS the surface code but whose target record lives in a project they cannot read. Only the server
 * can answer that, after loading the row, and the page's own error state is what reports it.
 *
 * `/projects/$projectKey` used to be excluded here for a DIFFERENT reason, and that reason was
 * upstream rather than about the record: its own list surface `/projects` carried no code, so there
 * was nothing to fold. Giving that surface its own entry in {@link NON_NAV_SURFACES} fixed the
 * cause, and the record then folds onto it exactly like the five above.
 *
 * Keep this table SMALL. An entry here is a claim that two paths are one surface; anything that is
 * genuinely its own surface belongs in the nav table — or, when the nav does not offer it at all, in
 * {@link NON_NAV_SURFACES} — with its own code.
 */
const NAV_PATH_ALIASES: Record<string, string> = {
  '/releases': '/timeboxes',
  '/milestones': '/timeboxes',
  // Record routes. Each folds onto the LIST surface it is the record of, so the code is the surface's
  // own and this table still states no code of its own.
  '/releases/$releaseId': '/timeboxes',
  '/milestones/$milestoneId': '/timeboxes',
  '/timeboxes/$iterationId': '/timeboxes',
  '/portfolio/$itemId': '/portfolio',
  '/capacity-planning/$planId': '/capacity-planning',
  // The one record whose surface is not a single row: a Story opens from Backlog and Iteration
  // Status, a Defect from Quality, a Task from Team Status. All FOUR carry `work_item:view`, so the
  // choice of target cannot change the code — `/backlog` is named because it is the primary one. If
  // those four ever gate on different codes this entry stops being well defined and must be revisited
  // rather than re-pointed.
  '/item/$itemKey': '/backlog',
  // `Manage Projects` and its record. The list is a surface of its own (see NON_NAV_SURFACES), so
  // this entry is the ordinary record-onto-list fold, not a claim about the nav.
  '/projects/$projectKey': '/projects',
}

/**
 * Surfaces the top nav does not offer, which are nonetheless their OWN surface with their own code.
 *
 * WHY NOT A NAV ROW. `NAV_ITEMS` is READ by `app-shell.tsx` to render the bar, so it is not usable as
 * a permission registry: a tenth row for `Manage Projects` would put an entry on screen that the BA's
 * nav does not have. The screen is reached from Settings > Workspaces & Projects instead — it used to
 * also hang off the Project/Team switcher, until GAP-P0-SHELL-007 ruled that dropdown may only change
 * delivery context. WHY NOT AN ALIAS: an
 * alias asserts two paths are ONE surface, and `/projects` is not another way into any nav screen —
 * it is the Projects list. Both properties the map defends survive: the code is still written down
 * once, and `router.tsx` still states none.
 *
 * `/projects` → `project:view`, from Phase 4 `02_Roles_Permissions/SRS.md:67`:
 * "| View `Workspaces & Projects` | All Projects | Assigned Project, all Teams | Assigned Project and
 * assigned Teams | Hidden |" — the row is visible to all three access levels and Hidden only for No
 * Access.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT. Every per-project access level holds `project:view` — it is
 * the code that answers "may this user see this project at all" — so the guard denies exactly one
 * principal: a NO ACCESS one, for whom the absence of an active `project_members` row resolves the
 * code to absent. That reader is real and Hidden is the right answer for them. It is NOT a boundary
 * between Admin and Editor, and it does not scope the list's ROWS — `listReadableProjectIds` on the
 * server does that, per project. The larger gain is upstream: with the list surface carrying a code,
 * `/projects/$projectKey` can fold onto it like every other record route, which is the only thing
 * that kept the pair unguarded.
 *
 * Keep this table SMALL, for the alias table's reason. `/settings`, `/notifications` and `/403` are
 * deliberately absent: they are self-scoped surfaces whose API routes are authentication-only, so
 * there is no code to gate them on and inventing one would gate a reader out of their own account.
 */
const NON_NAV_SURFACES: Record<string, string> = {
  '/projects': PERMISSION.PROJECT_VIEW,
}

export const NAV_PERMISSIONS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const item of NAV_ITEMS) {
    if (item.permission) map.set(item.path, item.permission)
    for (const child of item.children ?? []) {
      if (child.permission) map.set(child.path, child.permission)
    }
  }
  // Non-nav surfaces fold in SECOND — before the aliases, so a record route can alias onto one, and
  // never over a nav row: a path in both tables is a mistake, and the row that is on screen wins.
  for (const [path, code] of Object.entries(NON_NAV_SURFACES)) {
    if (!map.has(path)) map.set(path, code)
  }
  // Aliases fold in LAST and never overwrite: a real nav row always describes its own surface.
  for (const [alias, surface] of Object.entries(NAV_PATH_ALIASES)) {
    const code = map.get(surface)
    if (code !== undefined && !map.has(alias)) map.set(alias, code)
  }
  return map
})()

/** The code a route at `path` must be gated on, or `undefined` when the nav gates it on nothing. */
export function navPermissionFor(path: string): string | undefined {
  return NAV_PERMISSIONS.get(path)
}

/**
 * Is `path` the surface the reader is currently on?
 *
 * `/` matches only itself — every path starts with it, so a prefix test would light Home everywhere.
 */
export function isNavPathActive(currentPath: string, path: string): boolean {
  return path === '/' ? currentPath === '/' : currentPath.startsWith(path)
}

/**
 * Is `item` the top-nav GROUP the reader is inside? True for ANY of its children, not just for the
 * parent's own `path`.
 *
 * A parent row's `path` is only the dropdown's DEFAULT destination — {@link NAV_PERMISSIONS} derives
 * its map on the same principle, that the LEAF describes the surface. Testing the parent's path
 * alone therefore asked whether the reader was on the group's FIRST child, so the trigger lit for
 * that one child and went dark for every other: `Track` was unlit on `Team Status`, `Plan` on
 * `Timeboxes`, `Portfolio` on both `Capacity Planning` and `Release Tracking`. `Quality` looked
 * correct only because it happens to have a single child. The reader loses the one cue naming the
 * section they are in, on exactly the screens they navigated two levels to reach.
 *
 * Children are consulted UNFILTERED, permission-hidden ones included: a child the caller cannot see
 * is a child they cannot be standing on, so it can never match, and filtering first would make the
 * answer depend on a permission read this question does not need.
 *
 * `NAV_PATH_ALIASES` is consulted too, resolved by the longest matching key `currentPath` STARTS
 * WITH (the aliases are runtime path prefixes like `/releases`, not the route-template keys the
 * table also carries for `navPermissionFor`, e.g. `/releases/$releaseId` — those never appear in a
 * real pathname and are skipped here), because `/releases` and `/milestones` are TYPE MODES of
 * `/timeboxes` rather than children of their own (see the alias table's docblock) — `Plan`'s own row
 * lists only `/backlog` and `/timeboxes`, so the Timeboxes screen's Releases/Milestones dropdown
 * left `currentPath` matching neither, and `Plan` went dark on exactly the two modes that are not
 * the switcher's default. `/timeboxes/$iterationId` needs no separate case: it already starts with
 * `/timeboxes` and matches the plain child check above.
 */
export function isNavGroupActive(currentPath: string, item: NavItem): boolean {
  const aliasKey = Object.keys(NAV_PATH_ALIASES)
    .filter((key) => !key.includes('$') && currentPath.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  const resolvedPath = aliasKey ? NAV_PATH_ALIASES[aliasKey] : currentPath
  return (
    isNavPathActive(currentPath, item.path) ||
    (item.children ?? []).some(
      (child) =>
        isNavPathActive(currentPath, child.path) || isNavPathActive(resolvedPath, child.path),
    )
  )
}
