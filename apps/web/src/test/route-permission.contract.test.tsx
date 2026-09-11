/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { NAV_ITEMS, NAV_PERMISSIONS } from '@/shared/config/nav'

/**
 * "The nav and the router gate on the same code" — the contract.
 *
 * The defect
 * ----------
 * The SPA hid a nav item the caller lacked the permission for (`navItemState`, `app-shell.tsx`) and
 * the ROUTER carried no permission check whatsoever — every route required authentication and
 * nothing else. So a path typed, bookmarked or pasted into chat rendered its page for a caller whose
 * own nav did not offer it. That was invisible while the server over-granted; once the per-project
 * access model came into force, a project Editor's `/portfolio` request legitimately returned
 * nothing and the surface printed its EMPTY STATE — "this project has no Features" — a fabricated
 * fact about the DATA where the truth is a fact about the READER. Phase 4
 * `02_Roles_Permissions/SRS.md:197`: "A known route without sufficient action permission shows
 * Access Denied." (§198's Not-Found masking is for a specific record id whose existence is
 * sensitive. A top-level surface's absence from the nav already discloses that it exists, so
 * masking buys nothing and costs the reader the reason. The RECORD routes are gated on their
 * surface's code for the same reason — see "a RECORD route carries its surface's code" below, which
 * reverses an earlier assertion in this file that excluded them.)
 *
 * Two halves, both needed
 * -----------------------
 * 1. SOURCE contract — every permission-carrying nav path routes through `guardedPage` with that
 *    same path literal, and `router.tsx` states no permission code of its own. Prose cannot fail;
 *    this can. A second copy of the codes is the only way nav-hidden and route-open can drift apart
 *    again, so the assertion is aimed at the copy, not at the codes.
 * 2. BEHAVIOURAL contract — `RequirePermission` must not assert a denial before its source has
 *    arrived. This is why the guard is a component and not a router `beforeLoad`: a `beforeLoad`
 *    decides once, before render, while `GET /projects/:id/my-permissions` is still in flight, and
 *    would deny a legitimate Project Admin on a cold load. `CLAUDE.md` records that exact shape
 *    ("state FROZEN before its source arrived"), and records that it presented as a FLAKY TEST —
 *    which is why the pending phase is pinned here deterministically rather than left to timing.
 *
 * Scope note: this is UX only. `PolicyGuard` on the API is the authorization boundary and refuses
 * these requests independently of anything the SPA renders. Nothing asserted here is a security
 * control; it stops a bookmark rendering an empty grid that reads as data.
 */

// this file lives in src/test/
const SRC = join(import.meta.dirname, '../')
const ROUTER = readFileSync(join(SRC, 'app/router/router.tsx'), 'utf8')

/**
 * Nav paths gated on a permission but NOT wrapped in the router. **Must stay 0.**
 *
 * Unlike the counting ratchets next door this one has no legitimate residue: every surface AND every
 * record route in the map is an ordinary page component with nothing to stop it being wrapped. If a
 * future route genuinely cannot be (a redirect-only route, say — `/quality` and `/team-board` have no
 * component at all, and neither is a nav path), name it and its reason HERE rather than raising the
 * number silently.
 */
const MAX_UNGUARDED_NAV_ROUTES = 0

/** `const xRoute = createRoute({ … })` blocks, split so each route's own text can be read. */
function routeBlocks(): { routePath: string | null; guardedPath: string | null; src: string }[] {
  return ROUTER.split('createRoute({')
    .slice(1)
    .map((src) => ({
      // The route's own `path:` — the first one in the block. `component:` arguments are path
      // LITERALS with no `path:` key, so they cannot be mistaken for it.
      routePath: /\bpath:\s*'([^']*)'/.exec(src)?.[1] ?? null,
      guardedPath: /\bguardedPage\(\s*\n?\s*'([^']*)'/.exec(src)?.[1] ?? null,
      src,
    }))
}

describe('route ↔ nav permission contract', () => {
  it('every permission-carrying nav path is guarded with the SAME code', () => {
    // The code is not compared directly, and deliberately so: `guardedPage` resolves it by calling
    // `navPermissionFor(path)` against the very map this test imports, so sameness is STRUCTURAL
    // once the path literals agree. Comparing codes here would mean writing them down a third time
    // — the duplication the whole change removes. What can still go wrong is the path: a mistyped
    // literal resolves to `undefined` and gates nothing, silently. That is what this pins.
    const blocks = routeBlocks()
    const offenders: string[] = []

    for (const [navPath, code] of NAV_PERMISSIONS) {
      const block = blocks.find((b) => b.routePath === navPath)
      if (!block) {
        offenders.push(`${navPath} (nav gates on ${code}) — no route with this path in router.tsx`)
        continue
      }
      if (block.guardedPath === null) {
        offenders.push(
          `${navPath} (nav gates on ${code}) — uses lazyPage, so a bookmark renders it for a ` +
            `caller the nav hides it from. Use guardedPage('${navPath}', …).`,
        )
        continue
      }
      if (block.guardedPath !== navPath) {
        offenders.push(
          `${navPath} (nav gates on ${code}) — guardedPage('${block.guardedPath}') does not match ` +
            `the route path, so navPermissionFor() resolves undefined and the route is open.`,
        )
      }
    }

    expect(
      offenders.length,
      `Unguarded nav routes:\n  ${offenders.join('\n  ')}`,
    ).toBeLessThanOrEqual(MAX_UNGUARDED_NAV_ROUTES)
  })

  it('every guardedPage path in the router is a real nav entry', () => {
    // The mirror image of the assertion above, and the one that catches the failure mode the map
    // makes possible: `guardedPage('/portfolios', …)` type-checks, resolves to `undefined`, gates
    // nothing, and looks guarded to every reviewer.
    const used = [...ROUTER.matchAll(/\bguardedPage\(\s*\n?\s*'([^']*)'/g)].map((m) => m[1])
    const unknown = used.filter((p) => !NAV_PERMISSIONS.has(p))
    expect(
      unknown,
      `guardedPage() paths absent from NAV_PERMISSIONS: ${unknown.join(', ')}`,
    ).toEqual([])
    // Sanity floor: if this drops to nothing the first assertion would pass vacuously.
    expect(used.length).toBeGreaterThanOrEqual(NAV_PERMISSIONS.size)
  })

  it('the router states no permission code of its own', () => {
    // ONE source of truth or none. The router looks every code up by path, so a literal appearing
    // here means someone re-typed a code — and a re-typed code is exactly how the nav and the route
    // come to disagree again. (Matches `ns:view` / `ns:edit` / `ns:*` shaped literals.)
    const literals = [...ROUTER.matchAll(/'[a-z_]+:(?:view|edit|create|delete|manage|\*)'/g)].map(
      (m) => m[0],
    )
    expect(literals, `permission codes hardcoded in router.tsx: ${literals.join(', ')}`).toEqual([])
  })

  it('the shell consumes the shared nav table instead of declaring its own', () => {
    const shell = readFileSync(join(SRC, 'widgets/app-shell/app-shell.tsx'), 'utf8')
    expect(shell).toMatch(/from '@\/shared\/config\/nav'/)
    expect(shell).not.toMatch(/const NAV_ITEMS/)
  })

  it('a child nav entry overrides its parent — /portfolio is portfolio:view, not project:view', () => {
    // The one path where parent and leaf disagree, and the reason the flattening rule exists. The
    // Portfolio menu TRIGGER carries `project:view`, which every access level holds, so reading the
    // parent would have guarded the route with a code the Editor in the defect report already has
    // and left the empty grid exactly as it was. `capacity:view` is the control: a leaf whose parent
    // says nothing about it.
    expect(NAV_PERMISSIONS.get('/portfolio')).toBe('portfolio:view')
    expect(NAV_PERMISSIONS.get('/capacity-planning')).toBe('capacity:view')
    // Home is open to any authenticated caller — absent from the map is a real answer, not a gap.
    expect(NAV_PERMISSIONS.has('/')).toBe(false)
  })

  it("the Timeboxes TYPE modes carry the surface's own code", () => {
    // `/releases` and `/milestones` are modes of ONE screen — both declare
    // `staticData.breadcrumb: 'Timeboxes'` in `router.tsx` — and only the Iterations mode owns a nav
    // row. Deriving from `NAV_ITEMS` alone therefore left them out of the map, out of the assertion
    // above, and unguarded: a caller the nav denies `/timeboxes` could bookmark `/releases` and get
    // the same surface. §3.2:83 puts "Releases and Milestones" Hidden for an Editor in the same row
    // as Timeboxes, so one code covers all three.
    //
    // Asserted explicitly because the alias table is the only thing putting them in the map — drop
    // an entry and they leave the map AND the requirement together, which would unguard them
    // silently. This is the assertion that notices.
    expect(NAV_PERMISSIONS.get('/timeboxes')).toBe('timebox:view')
    expect(NAV_PERMISSIONS.get('/releases')).toBe('timebox:view')
    expect(NAV_PERMISSIONS.get('/milestones')).toBe('timebox:view')
  })

  it("a RECORD route carries its surface's code — §197, not §198", () => {
    // This assertion previously said the OPPOSITE, and said so deliberately: the record routes were
    // left out because §198 lets "a missing item, inaccessible Project or guessed identifier" show
    // Not Found, and because Access Denied on a SPECIFIC id can disclose that the id exists. That was
    // wrong about what is being gated. The code here is the SURFACE's, so the guard denies
    // `/portfolio/<anything>` without ever looking at the id and returns the same answer for a real
    // one and a fabricated one — it discloses nothing about any id and is decidable without loading
    // the row. §197 governs ("A known route without sufficient action permission shows Access
    // Denied") and §199 holds, because the denial renders no record data. Left unaliased these paths
    // were the bookmark defect with an id on the end: an Editor the nav denies `/portfolio` could
    // paste a Feature URL and get the record surface.
    //
    // §198's case is a different one this guard does not touch: a caller who HOLDS the surface code
    // but whose record lives in a project they cannot read. The server decides that after loading the
    // row, and the page's own error state reports it.
    expect(NAV_PERMISSIONS.get('/portfolio/$itemId')).toBe('portfolio:view')
    expect(NAV_PERMISSIONS.get('/capacity-planning/$planId')).toBe('capacity:view')
    expect(NAV_PERMISSIONS.get('/releases/$releaseId')).toBe('timebox:view')
    expect(NAV_PERMISSIONS.get('/milestones/$milestoneId')).toBe('timebox:view')
    // A work item's list surface is not one row — Backlog, Iteration Status, Team Status and Quality
    // all lead here — but all four carry `work_item:view`, so the record's code is unambiguous even
    // though its alias target had to be chosen. Asserted against the four so that a future divergence
    // between them fails HERE, where the alias stops being well defined.
    expect(NAV_PERMISSIONS.get('/item/$itemKey')).toBe('work_item:view')
    for (const surface of ['/backlog', '/iteration-status', '/team-status', '/quality/defects']) {
      expect(NAV_PERMISSIONS.get(surface), `${surface} no longer matches /item/$itemKey`).toBe(
        'work_item:view',
      )
    }
    // `/projects/$projectKey` was ALSO excluded once, and this assertion recorded the exclusion — but
    // its reason was never about the record: the list surface `/projects` carried no code, so there
    // was nothing to fold, and the router may not invent one (the assertion above forbids a literal).
    // That was a gap in the MAP, not a rule about records, so it is resolved rather than deleted:
    // `NON_NAV_SURFACES` gives the list its own `project:view` — §3.1:67 "View `Workspaces &
    // Projects`" is Hidden only for No Access — and the record folds onto it like the five above.
    // Kept as an assertion because the fold is silent when it fails: drop either table entry and both
    // paths leave the map AND the requirement together, unguarded, with nothing else to notice.
    expect(NAV_PERMISSIONS.get('/projects')).toBe('project:view')
    expect(NAV_PERMISSIONS.get('/projects/$projectKey')).toBe('project:view')
  })

  it('Test Case Detail is a deliberate THIRD shape — no nav row, no guardedPage, no alias', () => {
    // Unlike `/item/$itemKey` (a real nav-derived code folds on) and `/projects/$projectKey` (a
    // NON_NAV_SURFACES code folds on), `/test-case/$testCaseKey` has no list surface of its own to
    // fold a code from — it opens only from the Test Cases tab's ID link, and the PAGE owns its
    // whole denied state (403/404/other) via `test-case-detail-page.tsx`'s own three-outcome
    // handling, exactly like `WorkItemUnavailable` — see the plan's Phase 7 A13. So it correctly has
    // NO entry in `NAV_PERMISSIONS` and is NOT a `guardedPage()` call site; both loops above
    // therefore never see it, which is the intended outcome, not a gap in either map.
    expect(NAV_PERMISSIONS.has('/test-case/$testCaseKey')).toBe(false)
    const used = [...ROUTER.matchAll(/\bguardedPage\(\s*\n?\s*'([^']*)'/g)].map((m) => m[1])
    expect(used).not.toContain('/test-case/$testCaseKey')
  })

  it('Test Result Detail is the SAME deliberate third shape (Phase E)', () => {
    // Identical reasoning to Test Case Detail one line above: `/test-result/$testResultId` opens
    // only from the Results tab's Build-cell link, so it correctly has NO entry in
    // `NAV_PERMISSIONS` and is NOT a `guardedPage()` call site.
    expect(NAV_PERMISSIONS.has('/test-result/$testResultId')).toBe(false)
    const used = [...ROUTER.matchAll(/\bguardedPage\(\s*\n?\s*'([^']*)'/g)].map((m) => m[1])
    expect(used).not.toContain('/test-result/$testResultId')
  })

  it('a NON-NAV surface is in the map without being a nav row', () => {
    // The property that made the fix legal. `/projects` must gate the route and must NOT appear in
    // the bar — `NAV_ITEMS` is what `app-shell.tsx` renders, so a permission entry added there would
    // ship a nav item the BA's nav does not have. Asserted on both sides, because putting the code in
    // the obvious place would satisfy the guard and fail the design silently.
    const navPaths = NAV_ITEMS.flatMap((i) => [i.path, ...(i.children ?? []).map((c) => c.path)])
    expect(navPaths).not.toContain('/projects')
    expect(NAV_PERMISSIONS.has('/projects')).toBe(true)
  })
})

// ── Behavioural half: the three phases ────────────────────────────────────────
//
// Stubbed at the HOOK, not at the network: the phases are defined by what
// `useProjectPermissions` reports, and driving them through MSW would make the test about
// react-query's timing instead of about which phase renders what.

const permissionState: { permissions: string[]; isLoading: boolean; isError: boolean } = {
  permissions: [],
  isLoading: false,
  isError: false,
}

vi.mock('@/features/access/api', () => ({
  useProjectPermissions: () => ({
    ...permissionState,
    can: (code: string) =>
      permissionState.permissions.includes('workspace:*') ||
      permissionState.permissions.includes(code),
  }),
}))

vi.mock('@/shared/lib/stores/app-context.store', () => ({
  useAppContext: (select: (s: { project: { projectId: string } }) => unknown) =>
    select({ project: { projectId: 'p-1' } }),
}))

const { RequirePermission } = await import('@/features/access/ui/require-permission')

function renderGuard(code = 'portfolio:view') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(
    <RequirePermission code={code}>
      <p>the page</p>
    </RequirePermission>,
    { wrapper },
  )
}

describe('RequirePermission — three phases, and a denial is never one of the first two', () => {
  beforeEach(() => {
    permissionState.permissions = []
    permissionState.isLoading = false
    permissionState.isError = false
  })

  it('renders NOTHING that asserts anything while the permission read is in flight', () => {
    // The whole reason this is not a `beforeLoad`. A denial rendered here is a claim about the
    // reader made before the evidence arrived, and on a cold load it would hit a legitimate
    // Project Admin. The loading affordance carries `role="status"`, so "pending" and "denied"
    // cannot be confused by a screen reader either.
    permissionState.isLoading = true
    renderGuard()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('the page')).not.toBeInTheDocument()
  })

  it('renders the denial once resolved WITHOUT the code', () => {
    permissionState.permissions = ['project:view', 'work_item:view']
    renderGuard('portfolio:view')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('the page')).not.toBeInTheDocument()
  })

  it('renders the page when the code is granted', () => {
    permissionState.permissions = ['portfolio:view']
    renderGuard('portfolio:view')
    expect(screen.getByText('the page')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('grants a Workspace Admin through the baseline wildcard without a spinner', () => {
    // `can()` is checked BEFORE `isLoading` because the effective set is a superset of the
    // workspace baseline (the model is purely additive). A `workspace:*` holder must never flash a
    // denial or a spinner on a surface they hold unconditionally.
    permissionState.permissions = ['workspace:*']
    permissionState.isLoading = true
    renderGuard('portfolio:view')
    expect(screen.getByText('the page')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a FAILED permission read is not a denial', () => {
    // "We could not ask" is not "you may not". Reporting a 500 as Access Denied would be the same
    // absent-versus-error conflation the `query-default` ratchet exists to shrink, one layer up —
    // and the page's own request is the one positioned to report the failure honestly.
    permissionState.isError = true
    renderGuard('portfolio:view')
    expect(screen.getByText('the page')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
