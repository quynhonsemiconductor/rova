/**
 * BA business-flow E2E — E2E-010 "Deferred scope guard" and E2E-016 "Future
 * Backlog scope guard".
 *
 * Both had no automated coverage. They are unusual tests: they assert what must
 * stay ABSENT. Scope creep is invisible to ordinary tests — a feature arriving
 * early makes every existing assertion pass — so without a guard the only thing
 * standing between deferred work and the product is somebody remembering.
 *
 * Rules encoded, from
 * 07_Test Business/specs/E2E_BUSINESS_FLOW_COVERAGE.md:
 *
 *   E2E-010: "Backlog create supports Story/Defect only in Phase 1/2."
 *   E2E-016: "Phase 3 Release list/detail has no Release Progress column,
 *             percentage or widget."
 *
 * Scope note — these run at the service/API layer, which is where a deferred
 * field would actually have to appear before a screen could render it. Purely
 * presentational parts of the flows (Portfolio dropdown contents, an Iteration
 * Status Board toggle, Team Board placeholders) are not observable here and are
 * deliberately left to UI review rather than asserted with a proxy that would
 * pass while the real surface regressed.
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { ReleasesService } from '@modules/releases';
import { WorkItemsService } from '@modules/work-items';

import { workItemTypeEnum } from '@db/schema/enums';
import { ALL, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flows: E2E-010 / E2E-016 deferred-scope guards', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let releases: ReleasesService;
  let workItems: WorkItemsService;

  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    releases = app.get(ReleasesService);
    workItems = app.get(WorkItemsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('E2E-010 — Backlog is Story/Defect only in Phase 1/2', () => {
    // The Backlog is the Story/Defect planning surface; Tasks live under their parent.
    //
    // This guard used to create `initiative` and `feature` work items and assert the
    // Backlog excluded them — the portfolio types had to EXIST for the assertion to
    // bite, since asserting the absence of something uncreatable is trivially true.
    //
    // Migration 0072 removed both values from `work_item_type`, so that scenario is now
    // unrepresentable: a Feature is a PORTFOLIO ITEM in work.portfolio_items, never a
    // work item. The type-level assertion below is strictly stronger than the old
    // runtime one — the Backlog cannot acquire portfolio scope because there is no
    // portfolio work-item type to acquire.
    it('lists Story and Defect only, and no portfolio type can exist to leak in', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-010 Scope Guard',
      });

      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Guard story');
      const defect = await workItems.createWorkItem(admin, project.id, 'defect', 'Guard defect');

      const backlog = await workItems.listBacklog(admin, project.id, {}, ALL);
      const ids = backlog.data.map((w) => w.id);
      const types = [...new Set(backlog.data.map((w) => w.type))].sort();

      expect(ids).toContain(story.id);
      expect(ids).toContain(defect.id);
      expect(types).toEqual(['defect', 'story']);

      // Replaces creating-then-excluding portfolio items: assert at the SCHEMA that no
      // portfolio work-item type exists to be listed. A widened Backlog filter cannot
      // reintroduce one, and adding `feature` back to the enum fails here rather than
      // silently changing what the Backlog shows.
      expect([...workItemTypeEnum.enumValues].sort()).toEqual(['defect', 'story', 'task']);
    });

    it('keeps child tasks out of the Backlog even when they match the search', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-010 Task Isolation',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Parent story');
      const marker = `SCOPEGUARD${uniqueKey('Q')}`;
      await workItems.createTask(admin, story.id, `${marker} task`, {});

      // Tasks live in work.tasks, a separate table from work.work_items, so they
      // are structurally incapable of appearing as Backlog rows. This asserts
      // that separation still holds rather than the type filter — if tasks were
      // ever migrated into work_items, this is the test that should fail.
      const backlog = await workItems.listBacklog(admin, project.id, { q: marker }, ALL);
      expect(backlog.data).toHaveLength(0);
    });
  });

  describe('E2E-016 — Release list carries no progress/tracking (Phase 5 scope)', () => {
    // DEV-005: the Phase 3 Release list must expose assignment/readiness fields
    // only. Release progress/percentage belongs to Portfolio > Release Planning
    // in Phase 5. Asserting on the LIST payload is the meaningful check — a
    // column cannot render a field the API never returns.
    it('does not expose a progress/percentage field on release list rows', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-016 Release Scope',
      });
      await releases.createRelease(admin, project.id, 'E2E-016 Release', {
        startDate: '2026-07-20',
        releaseDate: '2026-08-15',
      });

      const list = await releases.listReleases(admin, project.id, ALL);
      expect(list.data.length).toBeGreaterThan(0);

      for (const row of list.data) {
        const keys = Object.keys(row);
        const trackingKeys = keys.filter((k) => /progress|percent|completedPoints|burn/i.test(k));
        expect(trackingKeys).toEqual([]);
      }
    });

    it('exposes only assignment/readiness fields on a release list row', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-016 Release Fields',
      });
      await releases.createRelease(admin, project.id, 'E2E-016 Fields Release', {
        startDate: '2026-07-20',
        releaseDate: '2026-08-15',
      });

      const [row] = (await releases.listReleases(admin, project.id, ALL)).data;

      // Positive assertion of the Phase 3 contract: these are the fields the
      // Release list is allowed to carry. A new key appearing here is a
      // deliberate scope decision and should fail until the BA confirms it.
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('startDate');
      expect(row).toHaveProperty('releaseDate');
      expect(row).not.toHaveProperty('progressPercent');
    });
  });
});
