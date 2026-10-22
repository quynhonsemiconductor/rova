/**
 * Five authorization boundaries, over REAL HTTP, with the roles that actually hit them.
 *
 * All five were found by auditing the BA's Phase 0/2/4 SRS against the code, and all five were
 * invisible in testing for the same reason: the dev principal is a Workspace Admin, whose
 * `workspace:*` grant is the global anchor. That is exactly how the `report:view` bug survived to
 * migration 0092, so these assertions name the ROLE rather than trusting a convenient session.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '@modules/access';
import { ACCESS_LEVEL_PERMISSIONS, permissionGrants } from '@shared-kernel';

import { AppModule } from '../../apps/api/src/app.module';
import {
  ADMIN_USER_ID,
  DEVELOPER_ID,
  NXP_ITER_CURRENT_ID,
  PAY_PROJECT_ID,
  SEED_PROJECTS,
  VIEWER_ID,
  WORKSPACE_ID,
} from '../../db/seeds/constants';
import { grantProjectAccess, SEEDED } from './support/flow-harness';
import { provisionUser, signIn } from './support/session';

const NXP = SEED_PROJECTS[0].id;

describe('authorization cluster (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** The session cookie from identity's test-login; the test app has no CSRF hook. */
  async function tokenFor(email: string): Promise<string> {
    const accessToken = await signIn(app, email);
    expect(accessToken, `test-login for ${email}`).toBeTruthy();
    return accessToken;
  }

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { cookie: token } });
  }

  function post(url: string, token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie: token },
      payload,
    });
  }

  it('lets a Project Member open a work item by KEY', async () => {
    /**
     * `GET /work-items/by-key` carried `workspace:view`, which only `workspace_admin` holds
     * (`workspace:*` is admin-reserved). Neither Project Admin nor Project Member has any
     * `workspace:*` code — and this route is the SOLE resolver behind `/item/$itemKey`, so every
     * notification click and every ID cell answered 403 for the two roles that do the work.
     *
     * The service already resolves the row and then asserts `work_item:view` on its OWN project,
     * which is the check that belongs here; the outer gate was denying what the inner one allowed.
     */
    const member = await tokenFor('dev@qnsc.dev');
    const response = await get('/work-items/by-key?itemKey=US-1', member);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('did not make the by-key route anonymous', async () => {
    /**
     * The by-key route now carries no `@RequirePermission` (the owning project is unknown until the
     * row is loaded, so `getWorkItemByKey` resolves it and then asserts `work_item:view` on that
     * project). This pins the thing that would make that a mistake: authentication must still be
     * required, so dropping the decorator cannot have opened the route.
     *
     * The DENY direction is asserted on ANONYMOUS access only, and the reason has changed since
     * this was written. The old note claimed "every seeded principal holds `work_item:view` —
     * `viewer@qnsc.dev` has it at WORKSPACE scope through `e2e_read_only`". That is no longer true
     * and nothing failed when it stopped being true: the custom role went with the AC-11 ruling and
     * `ensureViewerGrant` with it, so `viewer@qnsc.dev` now holds NOTHING anywhere — queried, and
     * pinned by the principal-matrix test at the bottom of this file. A role-based 403 case is
     * therefore available, and `report-authz.e2e.spec.ts` already uses that principal for exactly
     * that. Kept here as the anonymous check because it pins the thing that would make dropping the
     * decorator a mistake: authentication must still be required.
     */
    const anonymous = await app.inject({ method: 'GET', url: '/work-items/by-key?itemKey=US-1' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('lets a Project Member add an item to an iteration', async () => {
    /**
     * `POST /iterations/:id/work-items` required `iteration:edit`, which a Project Member does not
     * hold, while the Add New button is gated client-side on `work_item:create`, which they do. So
     * they saw the button, filled the modal and got a 403 — for an item they can create from the
     * Backlog. The Iteration Status SRS assigns this `work_item:create`.
     */
    const member = await tokenFor('dev@qnsc.dev');
    const response = await post(`/iterations/${NXP_ITER_CURRENT_ID}/work-items`, member, {
      type: 'story',
      title: `Authz cluster story ${Date.now()}`,
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  it('hides Plan > Timeboxes from an Editor while leaving Iteration Status open', async () => {
    /**
     * §3.2 marks `Timeboxes / Iterations` **Hidden** for an Editor and `Create, View, Edit, Delete`
     * for Admin and WA, while the row directly above it grants the Editor `Iteration Status | View
     * and update in assigned Teams`. `iteration:view` gated BOTH, so an Editor read the whole
     * timebox inventory — names, dates, states, commitment — on a screen the BA hides
     * (RBE-09 / P23-08 / P01-11). `timebox:view` is the code that separates them.
     *
     * BOTH DIRECTIONS, because either alone passes for the wrong reason. Only the refusal would
     * also be satisfied by revoking `iteration:view` from the Editor — which 403s Iteration Status,
     * the Backlog's iteration filter, Team Status and Quality, all four of which needed an iteration
     * feed. Only the grant is satisfied by the pre-split code.
     *
     * `GET /iterations` moved from the second list to the FIRST when the feed was split too: those
     * four surfaces read `GET /iterations/options` now (REFERENCE, every state) and write through
     * `GET /iterations/assignable` (ELIGIBILITY), so nothing an Editor may open depends on the
     * record any more. `iteration-feed-split.e2e.spec.ts` owns the population half of that.
     *
     * `dev@qnsc.dev` is the Editor: the seed gives it `project_members.access_level = 'editor'` on
     * NXP and NO workspace-scoped tier role (migration 0111/0112 and the comment in `demo.ts`), so
     * it is a real per-project Editor and not a principal whose baseline masks the check. These are
     * reads, so nothing here mutates the shared fixture — a spec that needed a GRANT would have to
     * create its own principal (see `report-authz.e2e.spec.ts`).
     */
    const editor = await tokenFor('dev@qnsc.dev');

    for (const url of [
      // The RECORD list joined this set in the second half of the split: its payload is `goal`,
      // `theme`, `notes` and `plannedVelocity`, so it is the `Plan > Timeboxes` grid's feed and
      // `timebox:view`. It answered 200 here until the two compact feeds below existed to take its
      // place — see `test/e2e/iteration-feed-split.e2e.spec.ts`.
      `/iterations?projectId=${NXP}`,
      `/iterations/${NXP_ITER_CURRENT_ID}`,
      `/iterations/${NXP_ITER_CURRENT_ID}/activity`,
    ]) {
      // 403, not 404: the iteration exists and the caller is identified — it is the PERMISSION
      // that is missing. A 404 would mean the guard resolved the wrong project from :id.
      const response = await get(url, editor);
      expect(response.statusCode, `${url} must be refused to an Editor`).toBe(403);
    }

    for (const url of [
      // REFERENCE (every state, plus `teamId`) and ELIGIBILITY (what may be written into — every
      // state as well since P6-VEL-004). Two routes, not one route with a flag: they answer different
      // questions, and the four §3.2 Editor surfaces read the first.
      `/iterations/options?projectId=${NXP}`,
      `/iterations/assignable?projectId=${NXP}`,
      `/iterations/${NXP_ITER_CURRENT_ID}/status`,
    ]) {
      const response = await get(url, editor);
      expect(response.statusCode, `${url} must stay open to an Editor`).toBe(200);
    }

    /**
     * And the Admin half of the same two §3.2 rows. On a DEDICATED principal: granting a level to a
     * shared fixture user is a lasting edit to `work.project_members`, which survives until the
     * next reset and silently changed what later specs saw — that is how upgrading `dev@qnsc.dev`
     * once broke `read-scoping.e2e.spec.ts`.
     */
    const login = await provisionUser(app, 'timebox-admin', 'E2E Timebox Admin');
    const userId = login.userId;
    await grantProjectAccess(app, userId, NXP, 'admin');

    for (const url of [
      `/iterations?projectId=${NXP}`,
      `/iterations/${NXP_ITER_CURRENT_ID}`,
      `/iterations/${NXP_ITER_CURRENT_ID}/activity`,
    ]) {
      const response = await get(url, login.accessToken);
      expect(response.statusCode, `${url} must be allowed for a project Admin`).toBe(200);
    }
  });

  it('closes the two workspace reads that were open to every member', async () => {
    /**
     * Neither carried `@RequirePermission`, and a route with no metadata is OPEN — so any
     * authenticated member could read the workspace's configuration and the pending-hire roster
     * (address plus assigned role), while both WRITE paths were correctly gated. The SRS reserves
     * both surfaces for Workspace Admin.
     */
    const member = await tokenFor('dev@qnsc.dev');
    const admin = await tokenFor('admin@qnsc.dev');

    for (const url of [
      `/workspaces/${WORKSPACE_ID}/settings`,
      `/workspaces/${WORKSPACE_ID}/invitations`,
    ]) {
      expect((await get(url, member)).statusCode, `${url} must be refused`).toBe(403);
      expect((await get(url, admin)).statusCode, `${url} for an admin`).toBe(200);
    }
  });

  /**
   * THE FIXTURE ITSELF, asserted — because the fixture is what hid the whole class.
   *
   * `demo.ts` used to grant DEVELOPER_ID `project_member` at `scopeType: 'workspace'`, which is the
   * row migration 0111 DELETEs as "pure legacy over-grant" and the seed then re-created on every
   * run. With it in place the project-scoped path was unreachable in testing, so there was nothing
   * left to observe — `read-scoping.e2e.spec.ts` said so in a comment ("the honest expectation here
   * is not 'fewer projects'"). That is the same masking as the Workspace Admin's `workspace:*`,
   * from a second direction, and it is what made the two P0 access defects of 2026-08-14 invisible.
   *
   * Nothing prevented it coming back. `pnpm db:migrate` RUNS the seed, so a re-added grant would
   * undo the migration on every local and CI database on the spot — exactly how `db/seeds/demo.ts`
   * re-wrote the `project_members` row that migration 0118 deletes. A comment cannot fail; this can.
   *
   * The matrix the rest of the suite depends on:
   *   admin@qnsc.dev   Workspace Admin  — `workspace:*`, the global anchor. Must EXIST (bootstrap
   *                                       needs one and every admin surface is tested through it).
   *   dev@qnsc.dev     Editor on NXP    — via `work.project_members.access_level`, and NO
   *                                       workspace-tier baseline at all.
   *   viewer@qnsc.dev  No Access        — no assignment anywhere, which is what makes it usable as
   *                                       the negative principal.
   */
  it('keeps the seeded principals a Workspace Admin, an Editor on ONE project, and No Access', async () => {
    const access = app.get(AccessService);

    const wa = await access.getWorkspacePermissions(ADMIN_USER_ID, WORKSPACE_ID);
    expect(permissionGrants(wa, 'workspace:*'), 'admin@qnsc.dev must stay a Workspace Admin').toBe(
      true,
    );

    /**
     * The Editor's WORKSPACE baseline must be empty. This is the assertion that fails if the
     * workspace-scoped tier grant is ever re-added: `getProjectPermissions` UNIONS the baseline, so
     * a baseline holding the delivery set makes every project look granted and no project-tier gate
     * can be observed to deny anything.
     */
    const editorBaseline = await access.getWorkspacePermissions(DEVELOPER_ID, WORKSPACE_ID);
    expect(
      editorBaseline,
      'dev@qnsc.dev must hold NO workspace-tier grant — see db/seeds/demo.ts and migration 0111',
    ).toEqual([]);

    // Editor on NXP, exactly the catalogue's Editor set…
    const onNxp = await access.getProjectPermissions(DEVELOPER_ID, WORKSPACE_ID, NXP);
    for (const code of ACCESS_LEVEL_PERMISSIONS.editor) {
      expect(permissionGrants(onNxp, code), `Editor on NXP must hold ${code}`).toBe(true);
    }
    // …and NOT the Admin-only codes, or the level is not the level the BA describes.
    for (const code of ['timebox:view', 'release:view', 'portfolio:view', 'report:view'] as const) {
      expect(permissionGrants(onNxp, code), `an Editor must NOT hold ${code}`).toBe(false);
    }

    // ONE project, not the workspace. PAY exists precisely so this has something to be false on.
    const onPay = await access.getProjectPermissions(DEVELOPER_ID, WORKSPACE_ID, PAY_PROJECT_ID);
    expect(
      permissionGrants(onPay, 'work_item:view'),
      'dev@qnsc.dev must be No Access on PAY — a grant on one project must not open another',
    ).toBe(false);

    // And a principal with no row anywhere, for the negative direction.
    const none = await access.getProjectPermissions(VIEWER_ID, WORKSPACE_ID, NXP);
    expect(none, 'viewer@qnsc.dev must resolve to No Access').toEqual([]);
  });

  /**
   * EVERY FEED an Editor's own screens load, over real HTTP.
   *
   * The second shape in this class, and the one a decorator test structurally cannot see: each gate
   * is individually correct, and the COMBINATION leaves a surface the Editor may open reading a
   * feed the Editor may not. It has now happened three times — the workspace roster (RBE-07), the
   * project roster (this week: every Editor saw `Unassigned` on every owned item), and
   * `GET /releases` labelling the Backlog's Release column. Every one of them renders as an empty
   * state rather than an error, because the SPA defaults query data to `[]`.
   *
   * A 200 here is not "the feed is correct" — it is "the Editor is not locked out of their own
   * screen", which is the property that kept breaking. `test/route-audience.ratchet.spec.ts` holds
   * the write-without-read half statically, including the two gaps that remain open.
   */
  it("serves every feed the Editor's own surfaces load", async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    for (const url of [
      // Backlog
      `/work-items/backlog?projectId=${NXP}`,
      `/projects/${NXP}`,
      `/projects/${NXP}/statuses`,
      `/projects/${NXP}/transitions`,
      `/projects/${NXP}/labels`,
      `/projects/${NXP}/estimation-settings`,
      // The owner / assignee picker split out of the project roster. `:id/members` is deliberately
      // NOT here: its decorator is `project:view`, which an Editor holds, and `ProjectsService`
      // then narrows it to "Workspace Admin or Project Admin" — see the refusal asserted below.
      // That divergence between the decorator and the effective audience is precisely what a
      // decorator-metadata sweep cannot see, and why this file exists alongside it.
      `/projects/${NXP}/member-options`,
      `/projects/${NXP}/teams`,
      // The Release and Milestone columns and pickers. `GET /releases` is `release:view` and
      // `GET /milestones` is `milestone:view` — both Admin-only §3.2 grids — so these two
      // reference feeds are what an Editor reads, and an Editor may already WRITE both references
      // (`PATCH bulk-release`, `PUT :id/milestones`, both `work_item:edit`).
      `/releases/options?projectId=${NXP}`,
      `/milestones/options?projectId=${NXP}`,
      // Work item detail
      `/work-items/${SEEDED.nxp.storyId}`,
      `/work-items/${SEEDED.nxp.storyId}/tasks`,
      `/work-items/${SEEDED.nxp.storyId}/relations`,
      `/work-items/${SEEDED.nxp.storyId}/attachments`,
      `/work-items/${SEEDED.nxp.storyId}/watchers`,
      `/work-items/${SEEDED.nxp.storyId}/labels`,
      `/work-items/${SEEDED.nxp.storyId}/milestones`,
      `/work-items/${SEEDED.nxp.storyId}/activity`,
      `/work-items/${SEEDED.nxp.storyId}/comments`,
      // Quality and Team Status — §5 Editor rows.
      `/quality/defects?projectId=${NXP}`,
      `/team-status?projectId=${NXP}&iterationId=${SEEDED.nxp.iterationCurrentId}`,
    ]) {
      const response = await get(url, editor);
      expect(
        response.statusCode,
        `${url} must be readable by an Editor — ${response.body.slice(0, 200)}`,
      ).toBe(200);
    }
  });

  /**
   * The reads an Editor is REFUSED, and the one I expected to be refused and is not.
   *
   * The refusals are declared gaps, mirroring `KNOWN_REFERENCE_FEED_GAPS` in
   * `test/route-audience.ratchet.spec.ts` — when the Milestone feed is split the way
   * `GET /releases/options` was, this test and that list change together.
   */
  it('refuses the admin roster and the three §3.2 grids to an Editor, but not their feeds', async () => {
    const editor = await tokenFor('dev@qnsc.dev');

    /**
     * The administrative half of the project roster split (RBE-07), refused in the SERVICE. Asserted
     * here because the route's own decorator is `project:view` — Editor-holdable — so nothing at the
     * decorator layer records that the effective audience is narrower. Its picker feed
     * `:id/member-options` is in the allow list above; both halves, or the next "gate the roster"
     * breaks the picker again.
     */
    const roster = await get(`/projects/${NXP}/members`, editor);
    expect(roster.statusCode, 'GET /projects/:id/members for an Editor').toBe(403);

    /**
     * The §3.2 Milestones GRID stays refused, and that is the correct half of the split: the BA
     * hides `Plan > Milestones` from an Editor. What must NOT be refused is the reference feed
     * `GET /milestones/options`, asserted in the test above — an Editor may already LINK a
     * milestone (`PUT :id/milestones` is `work_item:edit`), so a picker it cannot populate is the
     * roster regression again. Both halves, or "hide the grid" breaks the picker.
     */
    const milestones = await get(`/milestones?projectId=${NXP}`, editor);
    expect(milestones.statusCode, 'GET /milestones (the admin grid) for an Editor').toBe(403);

    // Same shape, same reason, for the Releases grid.
    const releases = await get(`/releases?projectId=${NXP}`, editor);
    expect(releases.statusCode, 'GET /releases (the admin grid) for an Editor').toBe(403);

    /**
     * The Portfolio Items GRID: 200 with NO ROWS, not a 403 — and this is the assertion that had to
     * be inverted, so the history matters.
     *
     * It used to assert the list was NON-EMPTY for an Editor, with a docblock explaining that
     * `listReadableProjectIds` unions in every project the caller has a `project_members` row on
     * regardless of the permission asked for, and calling that "the only reason the Feature picker
     * works". Both halves were true and together they were the defect: §3.2:85 and P5-PI-FR-017 make
     * Portfolio Items Hidden for an Editor, and the whole record — `notes`, `estimate`, `health`,
     * the owner — was readable by one. The permission-blind union is gone; membership now reaches
     * that method only through the permission-filtered synthesis.
     *
     * Empty rather than refused because the route's `projectId` is optional (a Workspace Admin lists
     * across projects), so the scope is a service-side filter and `[]` is its honest answer. Note
     * the explicit `projectId` here does NOT produce the 403 that
     * `portfolio-isolation.e2e.spec.ts` asserts for a readable-but-other project: `readable` is
     * empty, and that branch is checked first.
     *
     * `type` is REQUIRED on this query and the ValidationPipe runs BEFORE the guard, so an
     * incomplete query is a 400 that never reaches authorization — which would make either
     * expectation pass for the wrong reason.
     */
    const portfolio = await get(`/portfolio-items?type=feature&projectId=${NXP}`, editor);
    expect(portfolio.statusCode, 'GET /portfolio-items (the §3.2 grid) for an Editor').toBe(200);
    expect(
      (JSON.parse(portfolio.body) as { data: unknown[] }).data.length,
      'the Portfolio grid must be EMPTY for an Editor: NXP seeds an Epic and seven Features, and ' +
        '§3.2:85 / P5-PI-FR-017 hide Portfolio Items from an Editor',
    ).toBe(0);

    /**
     * …and the other half of the same split, which is what keeps the grid's emptiness from being a
     * regression. The `Feature` field on a Story is the Editor's own (§5.2:124 makes it the ONLY way
     * membership is ever set; §3.2:79 gives them the Story), so its picker reads a reference feed
     * gated on `work_item:view`. Without this the Editor would have a writable `featureId` whose
     * linked value renders as "No Feature" — the same shape as the owner-picker regression.
     */
    const featureOptions = await get(`/portfolio-items/options?projectId=${NXP}`, editor);
    expect(featureOptions.statusCode, 'GET /portfolio-items/options for an Editor').toBe(200);
    const options = JSON.parse(featureOptions.body) as { id: string; itemKey: string }[];
    expect(
      options.length,
      'the parent-Feature picker must stay populated for an Editor — NXP seeds seven Features',
    ).toBeGreaterThan(0);
    // The reference projection and nothing more: a record field appearing here would put the
    // hidden surface back on a feed every Editor reads.
    expect(Object.keys(options[0]).sort()).toEqual(['id', 'itemKey', 'name', 'projectId']);
  });

  /**
   * `GET /roles` — the whole authorization matrix, and until now readable by ANY authenticated
   * caller.
   *
   * It carried `@SharedRead('the role catalogue is workspace reference data every member sees in
   * pickers')`, so `PolicyGuard` found no permission metadata and allowed everyone, including a
   * principal with no role assignment at all. The justification was true when written and expired
   * silently: custom roles were deleted by the 2026-08-14 ruling, so no picker reads roles any more,
   * and per-project access is chosen from `admin | editor`. `roles:view` is workspace-tier and only
   * Workspace Admin holds it, which is also the tier of the one surface still reading the route (the
   * Audit Log tab, `audit:view`) — so the gate narrows no live reader.
   *
   * Asserted HERE and not in `route-policy.ratchet.spec.ts`, which reads source text and would be
   * just as satisfied by a misspelled code: this is the shape that proves the guard runs. BOTH
   * directions, because a denial test alone passes equally well against a route nobody can reach.
   */
  it('refuses the role catalogue to an Editor and serves it to a Workspace Admin', async () => {
    const editor = await tokenFor('dev@qnsc.dev');
    const admin = await tokenFor('admin@qnsc.dev');

    const denied = await get('/roles', editor);
    expect(denied.statusCode, 'GET /roles for a project Editor').toBe(403);
    // §199: a denied state must not disclose business data. A 403 body carries the error code only,
    // so the assertion is that no role name or permission code travels with it.
    expect(denied.body).not.toContain('permissions');
    expect(denied.body.toLowerCase()).not.toContain('workspace admin');

    const allowed = await get('/roles', admin);
    expect(allowed.statusCode, 'GET /roles for a Workspace Admin').toBe(200);
    const roles = JSON.parse(allowed.body) as { slug: string; permissions: string[] }[];
    expect(roles.length).toBeGreaterThan(0);
    // The matrix is still SERVED to the tier that may see it — the gate is not a removal.
    expect(roles.some((r) => r.permissions.length > 0)).toBe(true);
  });

  /**
   * `GET /workspaces/:id/members` is DELETED, and this asserts the absence rather than trusting it.
   *
   * It listed every member's `roleId` and account `status` behind an in-service claim that amounted
   * to `assertActive`, so any active workspace member — including one with No Access to every
   * project — read the whole company's role assignments. It had no consumer at all, which is why the
   * answer was deletion and not a gate: a gated dead route keeps the payload alive for whoever finds
   * it next and reads, in review, as a decision about an audience.
   *
   * Asserted for a WORKSPACE ADMIN deliberately. A 404 for an Editor would prove nothing — it is
   * what a gate would produce too. The one principal who could reach anything must also get nothing.
   */
  it('has no workspace member-list route left to reach', async () => {
    const admin = await tokenFor('admin@qnsc.dev');
    const ws = WORKSPACE_ID;

    const gone = await get(`/workspaces/${ws}/members`, admin);
    expect(gone.statusCode, 'GET /workspaces/:id/members must not exist').toBe(404);

    // Both audiences it used to serve still have a route, which is what makes the deletion safe
    // rather than a removal of function.
    const options = await get(`/workspaces/${ws}/member-options`, admin);
    expect(options.statusCode, 'the picker feed survives').toBe(200);
    const profile = await get(`/workspaces/${ws}/members-with-profile`, admin);
    expect(profile.statusCode, 'the administrative roster survives').toBe(200);
  });
});
