/**
 * Portfolio cross-project isolation E2E.
 *
 * The Portfolio list is the app's first CROSS-PROJECT list: `projectId` is optional
 * because a Workspace Admin lists Epics/Features across every project (BA spec §3.2) and
 * the grid carries a Project column. That makes the route gate weak by necessity —
 * `portfolio:view` is project-tier, so the PolicyGuard cannot resolve one project to
 * check against and the route only proves the caller may read the workspace.
 *
 * The real boundary is `AccessService.listReadableProjectIds`, applied by
 * `PortfolioItemsService` as a project filter. This spec is what makes that claim real:
 * a caller holding project_admin on project A must see A's portfolio items and must NOT
 * see B's, through the same service path production uses.
 *
 * Mirrors Rally, where access to an artifact follows from permission on its PROJECT
 * rather than from any per-artifact grant — Rally stores one ProjectPermission row per
 * (user, project, workspace) and a Viewer sees everything in that project.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { portfolioItems } from '@db/schema/work';
import { workspaceMembers } from '@db/schema/workspace';

import {
  ALL,
  WORKSPACE_ID,
  adminActor,
  bootRovaApp,
  makeActor,
  uniqueKey,
} from './support/flow-harness';

describe('portfolio cross-project isolation (e2e)', () => {
  let app: NestFastifyApplication;
  let portfolio: PortfolioItemsService;
  let projects: ProjectsService;
  let db: DrizzleDB;

  const admin = adminActor();
  /** Fresh per run: this suite does not clean up, and assignRole rejects duplicates. */
  const scopedUserId = randomUUID();
  /** Empty token — every decision must come from the database grant, not a claim. */
  const scopedActor = makeActor(scopedUserId, []);

  let projectAId: string;
  let projectBId: string;
  let featureAKey: string;
  let featureBKey: string;

  beforeAll(async () => {
    app = await bootRovaApp();
    portfolio = app.get(PortfolioItemsService);
    projects = app.get(ProjectsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const a = await projects.createProject(admin, { key: uniqueKey(), name: 'Portfolio Iso A' });
    const b = await projects.createProject(admin, { key: uniqueKey(), name: 'Portfolio Iso B' });
    projectAId = a.id;
    projectBId = b.id;

    // Inserted directly: write paths land in the next slice, and this spec is about the
    // READ boundary. Going through SQL keeps it honest about what the reader can see.
    featureAKey = `FE-ISO-${uniqueKey()}`;
    featureBKey = `FE-ISO-${uniqueKey()}`;
    await db.insert(portfolioItems).values([
      {
        workspaceId: WORKSPACE_ID,
        projectId: projectAId,
        itemKey: featureAKey,
        type: 'feature',
        name: 'Feature in A',
        // Ranks must be DISTINCT even in fixtures: two rows sharing a rank make
        // `between()` throw LEXORANK_NEIGHBOURS_OUT_OF_ORDER on the next reorder, so
        // hardcoding the same value here would leave a landmine for the ranking slice.
        rank: `a${featureAKey}`,
      },
      {
        workspaceId: WORKSPACE_ID,
        projectId: projectBId,
        itemKey: featureBKey,
        type: 'feature',
        name: 'Feature in B',
        rank: `a${featureBKey}`,
      },
    ]);

    // project_admin carries every project-tier permission, so a denial below can only
    // mean WRONG PROJECT — never a missing permission.
    // RBAC migration: addProjectMember requires workspace membership first.
    await db.insert(workspaceMembers).values({
      workspaceId: WORKSPACE_ID,
      userId: scopedUserId,
      status: 'active',
    });
    // RBAC migration: project access is now access_level on project_members.
    const member = await projects.setProjectAccess(
      WORKSPACE_ID,
      projectAId,
      scopedUserId,
      admin.sub,
      {},
    );
    await projects.updateProjectMember(
      WORKSPACE_ID,
      projectAId,
      member.id,
      { accessLevel: 'admin' },
      admin.sub,
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a workspace admin sees Features from both projects', async () => {
    // Establishes that both rows are findable at all, so the denial below is meaningful
    // rather than trivially true.
    const page = await portfolio.listItems(admin, { type: 'feature' }, ALL);
    const keys = page.data.map((i) => i.itemKey);
    expect(keys).toContain(featureAKey);
    expect(keys).toContain(featureBKey);
  });

  it('a project-scoped caller sees their own project and NOT the other', async () => {
    const page = await portfolio.listItems(scopedActor, { type: 'feature' }, ALL);
    const keys = page.data.map((i) => i.itemKey);

    expect(keys).toContain(featureAKey);
    expect(keys).not.toContain(featureBKey);
  });

  it('every row a project-scoped caller receives belongs to a readable project', async () => {
    // Stronger than checking one known key: nothing from any other project may appear,
    // including rows seeded by other suites.
    const page = await portfolio.listItems(scopedActor, { type: 'feature' }, ALL);
    const projectIds = [...new Set(page.data.map((i) => i.projectId))];
    expect(projectIds).toEqual([projectAId]);
  });

  it('asking explicitly for the other project is refused, not silently emptied', async () => {
    // A silent empty page would leak nothing but would also hide a real permission
    // problem from the caller. 403 says which it is.
    await expect(
      portfolio.listItems(scopedActor, { type: 'feature', projectId: projectBId }, ALL),
    ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
  });

  it('asking explicitly for the readable project still works', async () => {
    const page = await portfolio.listItems(
      scopedActor,
      { type: 'feature', projectId: projectAId },
      ALL,
    );
    expect(page.data.map((i) => i.itemKey)).toContain(featureAKey);
  });

  it('resolves the project NAME server-side, for the cross-project Project column', async () => {
    // The grid has a Project column because this list spans projects, so the name is
    // row data. Resolving it on the client would mean fetching every project a page
    // touches just to render one column.
    const page = await portfolio.listItems(admin, { type: 'feature' }, ALL);
    const row = page.data.find((i) => i.itemKey === featureAKey);
    expect(row?.projectName).toBe('Portfolio Iso A');
  });

  it('the total count is subject to the SAME filter as the rows', async () => {
    // A count computed without `readableProjectIds` would still leak: the rows would be
    // correctly hidden while the footer announced how many Features exist in projects the
    // caller cannot read. So the admin's total must be strictly larger than the scoped
    // caller's, and the scoped caller's must equal what they can actually see.
    const adminPage = await portfolio.listItems(admin, { type: 'feature' }, ALL);
    const scopedPage = await portfolio.listItems(scopedActor, { type: 'feature' }, ALL);

    expect(scopedPage.pageInfo.total).toBe(scopedPage.data.length);
    expect(adminPage.pageInfo.total).toBeGreaterThan(scopedPage.pageInfo.total as number);
  });

  it('a caller with no project grant at all sees nothing', async () => {
    // Fails CLOSED: an empty readable list must return no rows, never every row.
    const stranger = makeActor(randomUUID(), []);
    const page = await portfolio.listItems(stranger, { type: 'feature' }, ALL);
    expect(page.data).toEqual([]);
  });
});
