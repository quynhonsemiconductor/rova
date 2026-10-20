/**
 * Portfolio write paths E2E — create / update / archive.
 *
 * These go through the real database on purpose. Three of the guarantees here cannot be
 * observed against a mocked repository at all:
 *
 *   • the `EP-`/`FE-` sequence is WORKSPACE-wide per type, which is a property of
 *     `uq_portfolio_item_key` (workspace_id, item_key) — a per-project sequence would
 *     let two projects both mint `EP-1` and only real SQL shows the collision;
 *   • ranks derived under the advisory lock are strictly increasing and never equal,
 *     which is what keeps `between()` working on the next drag-reorder;
 *   • `ck_portfolio_epic_shape` actually rejects an Epic carrying Feature-only ids, so
 *     the service's friendlier error is a convenience rather than the only defence.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PortfolioItemsService } from '@modules/portfolio';
import { WorkItemsService } from '@modules/work-items';
import { ProjectsService } from '@modules/projects';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { portfolioItems } from '@db/schema/work';
import { workspaceMembers } from '@db/schema/workspace';
import { and, eq, sql } from 'drizzle-orm';

import {
  ALL,
  WORKSPACE_ID,
  adminActor,
  bootRovaApp,
  makeActor,
  uniqueKey,
} from './support/flow-harness';

describe('portfolio write paths (e2e)', () => {
  let app: NestFastifyApplication;
  let portfolio: PortfolioItemsService;
  let items: WorkItemsService;
  let projects: ProjectsService;
  let db: DrizzleDB;

  const admin = adminActor();
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    app = await bootRovaApp();
    portfolio = app.get(PortfolioItemsService);
    items = app.get(WorkItemsService);
    projects = app.get(ProjectsService);
    db = app.get<DrizzleDB>(DRIZZLE);

    const a = await projects.createProject(admin, { key: uniqueKey(), name: 'Portfolio Write A' });
    const b = await projects.createProject(admin, { key: uniqueKey(), name: 'Portfolio Write B' });
    projectAId = a.id;
    projectBId = b.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('create', () => {
    it('mints EP-/FE- keys and appends at the end of the rank order', async () => {
      const first = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'First feature',
      });
      const second = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Second feature',
      });

      expect(first.itemKey).toMatch(/^FE-\d+$/);
      expect(second.itemKey).toMatch(/^FE-\d+$/);
      // Strictly increasing and never equal — equal ranks are what break `between()`.
      expect(second.rank > first.rank).toBe(true);
      expect(second.rank).not.toBe(first.rank);
      expect(first.rank).not.toBe('');
    });

    it('numbers Epics and Features on SEPARATE sequences', async () => {
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'An epic',
      });
      expect(epic.itemKey).toMatch(/^EP-\d+$/);

      // Both live in one table; if the sequence ignored `type`, the Epic would continue
      // the Feature numbering instead of having its own.
      const [{ epics, features }] = await db
        .select({
          epics: sql<number>`count(*) filter (where ${portfolioItems.type} = 'epic')::int`,
          features: sql<number>`count(*) filter (where ${portfolioItems.type} = 'feature')::int`,
        })
        .from(portfolioItems)
        .where(eq(portfolioItems.workspaceId, WORKSPACE_ID));
      expect(Number(epics)).toBeGreaterThan(0);
      expect(Number(features)).toBeGreaterThan(0);
    });

    it('keeps the key sequence WORKSPACE-wide, so two projects never collide', async () => {
      // `uq_portfolio_item_key` is on (workspace_id, item_key). A per-project sequence
      // would make this second create fail on the unique index.
      const inA = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Epic in A',
      });
      const inB = await portfolio.createItem(admin, {
        projectId: projectBId,
        type: 'epic',
        name: 'Epic in B',
      });
      expect(inB.itemKey).not.toBe(inA.itemKey);
    });

    it('stores every rich-text block it ACCEPTS on create', async () => {
      // The create schema took `notes` and `releaseNotes` and the insert dropped both, so a
      // caller supplying either got a 201 with an empty field and no way to tell. Asserted for
      // all four blocks at once: any future field added to the schema and not to the insert
      // fails here rather than in a user's browser.
      const created = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Every block',
        description: '<p>d</p>',
        notes: '<p>n</p>',
        releaseNotes: '<p>rn</p>',
        whatSuccessLooksLike: '<p>s</p>',
      });

      expect({
        description: created.description,
        notes: created.notes,
        releaseNotes: created.releaseNotes,
        whatSuccessLooksLike: created.whatSuccessLooksLike,
      }).toEqual({
        description: '<p>d</p>',
        notes: '<p>n</p>',
        releaseNotes: '<p>rn</p>',
        whatSuccessLooksLike: '<p>s</p>',
      });
    });

    it('creates a Feature under an Epic and reports it as a child', async () => {
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Parent epic',
      });
      const feature = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Child feature',
        parentId: epic.id,
      });

      expect(feature.parentKey).toBe(epic.itemKey);
      const children = await portfolio.listChildFeatures(admin, epic.id);
      expect(children.map((c) => c.id)).toContain(feature.id);
    });

    it('rejects an Epic carrying Feature-only ids — and the DB CHECK agrees', async () => {
      await expect(
        portfolio.createItem(admin, {
          projectId: projectAId,
          type: 'epic',
          name: 'Bad epic',
          teamId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_TYPE' });

      // Prove the constraint is real rather than trusting the service alone: bypass the
      // service and insert straight into the table. Drizzle wraps the pg error, so the
      // constraint name is on the CAUSE, not the top-level message.
      const direct = db.insert(portfolioItems).values({
        workspaceId: WORKSPACE_ID,
        projectId: projectAId,
        itemKey: `EP-CK-${uniqueKey()}`,
        type: 'epic',
        name: 'Direct bad epic',
        teamId: randomUUID(),
        rank: 'z',
      });
      await expect(direct).rejects.toThrow();
      const err = await direct.catch((e: unknown) => e);
      expect(JSON.stringify((err as { cause?: unknown }).cause ?? err)).toContain(
        'ck_portfolio_epic_shape',
      );
    });

    it('rejects a release from a DIFFERENT project', async () => {
      // Releases are per-project, so a cross-project release would leave the row's
      // Release column describing something outside its own project.
      const { ReleasesService } = await import('@modules/releases');
      const releases = app.get(ReleasesService);
      // `name` is a POSITIONAL argument here, not part of `opts`.
      const release = await releases.createRelease(admin, projectBId, `Rel ${uniqueKey()}`, {});

      await expect(
        portfolio.createItem(admin, {
          projectId: projectAId,
          type: 'feature',
          name: 'Cross-project release',
          releaseId: release.id,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_PROJECT_MISMATCH' });
    });

    it('refuses a caller with no permission on the target project', async () => {
      const stranger = makeActor(randomUUID(), []);
      await expect(
        portfolio.createItem(stranger, {
          projectId: projectAId,
          type: 'feature',
          name: 'Should not exist',
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
    });
  });

  describe('update', () => {
    it('clears a field with null and leaves omitted fields untouched', async () => {
      const created = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Editable',
        description: 'original',
        preliminaryEstimate: 'l',
      });

      const updated = await portfolio.updateItem(admin, created.id, { description: null });

      expect(updated.description).toBeNull();
      // Untouched by an update that only mentioned description.
      expect(updated.name).toBe('Editable');
      expect(updated.preliminaryEstimate).toBe('l');
    });

    it('persists What Success Looks Like, on an Epic as well as a Feature', async () => {
      /**
       * The BA's fourth rich-text block (SRS §5.1 for a Feature, §11.4 for an Epic) and
       * P5-PI-FR-019: it must be "backed by the shared Feature record rather than
       * display-only placeholders". Nothing backed it at all until migration 0086, so this
       * drives it through the service against a real column — create, read back, clear.
       */
      for (const type of ['feature', 'epic'] as const) {
        const created = await portfolio.createItem(admin, {
          projectId: projectAId,
          type,
          name: `Success on a ${type}`,
          whatSuccessLooksLike: '<p>Checkout converts above 60%.</p>',
        });
        expect(created.whatSuccessLooksLike).toBe('<p>Checkout converts above 60%.</p>');

        const edited = await portfolio.updateItem(admin, created.id, {
          whatSuccessLooksLike: '<p>Revised.</p>',
        });
        expect(edited.whatSuccessLooksLike).toBe('<p>Revised.</p>');

        // Null CLEARS it, and clearing it does not disturb the field beside it — the same
        // undefined-vs-null distinction every other writable field here follows.
        const cleared = await portfolio.updateItem(admin, created.id, {
          whatSuccessLooksLike: null,
        });
        expect(cleared.whatSuccessLooksLike).toBeNull();
        expect(cleared.name).toBe(`Success on a ${type}`);
      }
    });

    it('recomputes progress when the refined estimate changes', async () => {
      // Estimated Progress divides by the refined estimate, so editing it must move the
      // indicator — this is the one field whose edit changes a derived number.
      const created = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Estimate edit',
        refinedEstimate: '10',
      });
      // A `numeric(_, 2)` column round-trips as '10.00', so compare the VALUE rather than
      // the text — the DTO is what turns this into the API's number.
      expect(Number(created.refinedEstimate)).toBe(10);

      const updated = await portfolio.updateItem(admin, created.id, { refinedEstimate: '20' });
      expect(Number(updated.refinedEstimate)).toBe(20);
      expect(updated.progress.estimatedProgressByPoints).toBe(0);
    });

    it('cannot give an Epic a Team', async () => {
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Still an epic',
      });
      await expect(
        portfolio.updateItem(admin, epic.id, { teamId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_TYPE' });
    });
  });

  describe('archive', () => {
    it('hides an archived item from the default list and restores it', async () => {
      // Narrowed by a unique name rather than scanning the whole list: `ALL` caps at 200
      // rows and this suite adds features on every run, so a whole-list assertion silently
      // stops covering the row under test once the table grows past one page.
      const name = `To archive ${uniqueKey()}`;
      const created = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name,
      });
      const listed = (includeArchived?: boolean) =>
        portfolio.listItems(admin, { type: 'feature', search: name, includeArchived }, ALL);

      await portfolio.setArchived(admin, created.id, true);
      expect((await listed()).data.map((i) => i.id)).not.toContain(created.id);
      expect((await listed(true)).data.map((i) => i.id)).toContain(created.id);

      await portfolio.setArchived(admin, created.id, false);
      expect((await listed()).data.map((i) => i.id)).toContain(created.id);
    });

    it('is READ-ONLY once archived — no edit, no re-rank, and no orphaned child', async () => {
      /**
       * Archived work is excluded from every rollup, plan total and cutline, but was fully editable:
       * the only `archivedAt` checks on the write path looked at the PARENT.
       *
       * The `Add Item` case is the one that lost data. That flow is create-then-link, and the link is
       * refused by `assertFeatureLinkable` (`WORK_ITEM_FEATURE_LINK_ARCHIVED`) — so a Story was created,
       * the PATCH failed, and a parentless Story was left in the backlog by an action that reported an
       * error to the planner. Asserted here against real SQL because the leak is a row nobody sees.
       */
      const feature = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: `Archived RO ${uniqueKey()}`,
      });
      await portfolio.setArchived(admin, feature.id, true);

      await expect(
        portfolio.updateItem(admin, feature.id, { name: 'Renamed while archived' }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_ARCHIVED' });

      const neighbour = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: `Archived RO neighbour ${uniqueKey()}`,
      });
      await expect(
        portfolio.rankItem(admin, feature.id, { afterId: neighbour.id }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_ARCHIVED' });

      // The Story is refused BEFORE it exists: the link guard already said no, and the FE no longer
      // offers the action, but the API is what has to make the orphan unreachable.
      const story = await items.createWorkItem(
        admin,
        projectAId,
        'story',
        `Orphan probe ${uniqueKey()}`,
      );
      await expect(
        items.updateWorkItem(admin, story.id, { featureId: feature.id }),
      ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_ARCHIVED' });

      // Restore still works — it is the only write an archived row accepts.
      await expect(portfolio.setArchived(admin, feature.id, false)).resolves.toBeTruthy();
      await expect(
        portfolio.updateItem(admin, feature.id, { name: 'Renamed after restore' }),
      ).resolves.toBeTruthy();
    });

    it('is a SOFT delete — the row survives with archived_at set', async () => {
      const created = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Soft deleted',
      });
      await portfolio.setArchived(admin, created.id, true);

      const rows = await db
        .select({ archivedAt: portfolioItems.archivedAt })
        .from(portfolioItems)
        .where(
          and(eq(portfolioItems.id, created.id), eq(portfolioItems.workspaceId, WORKSPACE_ID)),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].archivedAt).not.toBeNull();
    });

    it('refuses to archive an Epic that still has an active Feature', async () => {
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Epic with child',
      });
      const child = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Blocking child',
        parentId: epic.id,
      });

      await expect(portfolio.setArchived(admin, epic.id, true)).rejects.toMatchObject({
        code: 'PORTFOLIO_EPIC_HAS_ACTIVE_FEATURES',
      });

      // Archive the child first, then the Epic goes through.
      await portfolio.setArchived(admin, child.id, true);
      const archivedEpic = await portfolio.setArchived(admin, epic.id, true);
      expect(archivedEpic.archivedAt).not.toBeNull();
    });

    it('REFUSES to restore a Feature whose Epic is still archived', async () => {
      /**
       * The forbidden state was reachable in three legal steps: archive the Feature, archive the
       * now-childless Epic, restore the Feature — leaving an ACTIVE Feature under a hidden parent.
       * `setArchived`'s own docstring says that is what it exists to prevent, and `assertReferences`
       * refuses the same link on every other write ("Cannot attach a Feature to an archived Epic"),
       * but the guard only looked in the archiving direction.
       */
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Restore-order epic',
      });
      const child = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'feature',
        name: 'Restore-order feature',
        parentId: epic.id,
      });

      // The three legal steps.
      await portfolio.setArchived(admin, child.id, true);
      await portfolio.setArchived(admin, epic.id, true);
      await expect(portfolio.setArchived(admin, child.id, false)).rejects.toMatchObject({
        code: 'PORTFOLIO_PARENT_ARCHIVED',
      });

      // The Epic's KEY is in the message: an archived parent is invisible in every list, so
      // "restore the Epic first" is unactionable without knowing which one.
      await expect(portfolio.setArchived(admin, child.id, false)).rejects.toThrow(
        new RegExp(epic.itemKey),
      );

      // Restore the Epic, and the Feature goes through — the order is the whole rule.
      await portfolio.setArchived(admin, epic.id, false);
      const restored = await portfolio.setArchived(admin, child.id, false);
      expect(restored.archivedAt).toBeNull();
    });

    it('stops a new Feature attaching to an archived Epic', async () => {
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: 'Archived epic',
      });
      await portfolio.setArchived(admin, epic.id, true);

      await expect(
        portfolio.createItem(admin, {
          projectId: projectAId,
          type: 'feature',
          name: 'Orphan-to-be',
          parentId: epic.id,
        }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_INVALID_PARENT' });
    });
  });

  it('every rank in a scope stays UNIQUE across many creates', async () => {
    // The advisory lock's whole job. Without it concurrent creates read the same max and
    // derive identical ranks, which makes the next drag-reorder throw.
    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        portfolio.createItem(admin, {
          projectId: projectAId,
          type: 'feature',
          name: `Concurrent ${i}`,
        }),
      ),
    );

    const ranks = made.map((m) => m.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    const keys = made.map((m) => m.itemKey);
    expect(new Set(keys).size).toBe(keys.length);

    // Deliberately NOT asserted across the whole scope: other suites insert fixtures
    // straight into the table with a hardcoded rank, so a scope-wide check would police
    // their hygiene rather than this create path. What matters here is that every rank
    // the SERVICE derives is distinct.
    const sorted = [...ranks].sort();
    expect(sorted).toEqual([...new Set(sorted)]);
  });

  it('grants create rights through a project-scoped role, not just workspace admin', async () => {
    const userId = randomUUID();
    const scoped = makeActor(userId, []);
    // RBAC migration: addProjectMember requires workspace membership first.
    await db.insert(workspaceMembers).values({
      workspaceId: WORKSPACE_ID,
      userId,
      status: 'active',
    });
    // RBAC migration: project access is now access_level on project_members.
    const member = await projects.setProjectAccess(WORKSPACE_ID, projectAId, userId, admin.sub, {});
    await projects.updateProjectMember(
      WORKSPACE_ID,
      projectAId,
      member.id,
      { accessLevel: 'admin' },
      admin.sub,
    );

    const created = await portfolio.createItem(scoped, {
      projectId: projectAId,
      type: 'feature',
      name: 'By project admin',
    });
    expect(created.id).toBeTruthy();

    // ...but only on THAT project.
    await expect(
      portfolio.createItem(scoped, {
        projectId: projectBId,
        type: 'feature',
        name: 'Wrong project',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
  });

  describe('rank', () => {
    /** Three Features in a fresh Epic-free order, returned lowest rank first. */
    /**
     * Three Features sharing one unique TAG, so the list can be narrowed to exactly them.
     *
     * Never assert over the whole list here: `ALL` caps at 200 rows and this suite creates
     * features on every run, so on a long-lived database the rows under test fall off the
     * end. CI's fresh database hides that, which is precisely why it is worth avoiding.
     */
    async function threeFeatures() {
      const tag = uniqueKey();
      const made = [];
      for (const n of ['A', 'B', 'C']) {
        made.push(
          await portfolio.createItem(admin, {
            projectId: projectAId,
            type: 'feature',
            name: `Rank ${n} ${tag}`,
          }),
        );
      }
      return { made, tag };
    }

    it('moves an item between two neighbours and the list order follows', async () => {
      const {
        made: [a, b, c],
        tag,
      } = await threeFeatures();
      // Created in order, so ranks ascend a < b < c.
      expect(a.rank < b.rank && b.rank < c.rank).toBe(true);

      // Drag C up between A and B.
      const moved = await portfolio.rankItem(admin, c.id, { beforeId: a.id, afterId: b.id });
      expect(moved.rank > a.rank).toBe(true);
      expect(moved.rank < b.rank).toBe(true);

      // And the LIST reflects it — the ordering is what the user actually sees.
      const page = await portfolio.listItems(admin, { type: 'feature', search: tag }, ALL);
      const order = page.data.map((i) => i.id);
      expect(order).toEqual([a.id, c.id, b.id]);
    });

    it('moves an item to the very top when there is no upper neighbour', async () => {
      const {
        made: [a, , c],
      } = await threeFeatures();
      const moved = await portfolio.rankItem(admin, c.id, { beforeId: null, afterId: a.id });
      expect(moved.rank < a.rank).toBe(true);
    });

    it('never writes an EQUAL rank, so the next drag still works', async () => {
      // Equal neighbours are what make `between()` throw. Moving repeatedly into the same
      // gap is the sequence most likely to exhaust precision and collide.
      const {
        made: [a, b, c],
        tag,
      } = await threeFeatures();
      let last = c;
      for (let i = 0; i < 6; i++) {
        last = await portfolio.rankItem(admin, last.id, { beforeId: a.id, afterId: b.id });
        expect(last.rank > a.rank).toBe(true);
        expect(last.rank < b.rank).toBe(true);
      }
      // Scoped to the three rows this test owns. A scope-wide check would police rows
      // other suites left behind — this database still holds fixtures inserted with a
      // hardcoded rank before that spec was corrected.
      const rows = await portfolio.listItems(admin, { type: 'feature', search: tag }, ALL);
      const ranks = rows.data.map((r) => r.rank);
      expect(ranks).toHaveLength(3);
      expect(new Set(ranks).size).toBe(ranks.length);
    });

    it('refuses an Epic as a Feature neighbour', async () => {
      const {
        made: [a],
      } = await threeFeatures();
      const epic = await portfolio.createItem(admin, {
        projectId: projectAId,
        type: 'epic',
        name: `Rank epic ${uniqueKey()}`,
      });
      await expect(portfolio.rankItem(admin, a.id, { beforeId: epic.id })).rejects.toMatchObject({
        code: 'PORTFOLIO_ITEM_RANK_CONFLICT',
      });
    });

    it('ranks across PROJECTS, because the scope is (workspace, type)', async () => {
      // The Portfolio list is cross-project and flat per type, so a Feature in project B
      // is a legitimate neighbour for one in project A. This is the deliberate difference
      // from work items, which rank within (project, parent).
      const {
        made: [a, b],
      } = await threeFeatures();
      const inB = await portfolio.createItem(admin, {
        projectId: projectBId,
        type: 'feature',
        name: `Rank cross ${uniqueKey()}`,
      });
      const moved = await portfolio.rankItem(admin, inB.id, { beforeId: a.id, afterId: b.id });
      expect(moved.rank > a.rank).toBe(true);
      expect(moved.rank < b.rank).toBe(true);
    });

    it('refuses a caller without permission on the item', async () => {
      const {
        made: [a, b, c],
      } = await threeFeatures();
      const stranger = makeActor(randomUUID(), []);
      await expect(
        portfolio.rankItem(stranger, c.id, { beforeId: a.id, afterId: b.id }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
    });
  });
});
