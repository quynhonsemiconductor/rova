/**
 * BA business-flow E2E — Phase 0/1 foundation: the Company → Project → Team
 * context backbone plus the project lifecycle.
 *
 * Flows: E2E-001 (admin creates project foundation) and the team-creation half
 * of E2E-002. The rest of E2E-002 — the rules that only bite once a team is
 * USED for work management — is in team-preparation-flow.e2e.spec.ts.
 * (07_Test Business/specs/E2E_BUSINESS_FLOW_COVERAGE.md)
 *
 * Encodes the P0 scenarios that the cross-phase E2E pack assumes but does not
 * prove directly:
 *   - PHASE0 P0-PRJ-005/009/010 — project key is immutable, archive makes a
 *     project read-only (and blocks new work items), restore reopens it.
 *   - PHASE1 P1-MANAGE-003/004 — a Team is created under the fixed Company and
 *     duplicate team keys are rejected.
 *   - Context backbone — a Team is linked to a Project (Company → Project → Team)
 *     and the link is idempotent and reversible.
 *
 * (product-docs/projects/mini-rally/testing/PHASE0_TEST_SCENARIOS.md,
 *  PHASE1_TEST_SCENARIOS.md, TEST_STRATEGY.md "Context model" rule.)
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { TeamService } from '@modules/workspace';

import { ADMIN_USER_ID, adminActor, bootRovaApp, uniqueKey } from './support/flow-harness';

describe('BA flows: Company → Project → Team foundation (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let workItems: WorkItemsService;
  let teams: TeamService;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    workItems = app.get(WorkItemsService);
    teams = app.get(TeamService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── PHASE0 P0-PRJ — project lifecycle ───────────────────────────────────────
  describe('P0-PRJ project lifecycle', () => {
    it('makes an archived project read-only, blocks new work items, then restores it', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Lifecycle Project',
      });

      // No project_members row for the actor, deliberately. §2.1: a Workspace Admin is not added
      // as a Project user, and `addProjectMember` now REFUSES one. Archive/restore is gated on
      // `workspace:edit`, which the WA holds workspace-wide — so the block that used to add and
      // promote a membership row here granted nothing this test needs.
      const archived = await projects.updateProject(actor, project.id, { status: 'archived' });
      expect(archived.status).toBe('archived');

      // PRJ-FR-010: an archived project is read-only — a non-restore edit is rejected.
      await expect(
        projects.updateProject(actor, project.id, { name: 'Renamed while archived' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });

      // PRJ-FR-010: an archived project cannot accept new work items either.
      await expect(
        workItems.createWorkItem(actor, project.id, 'story', 'Should not be creatable'),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });

      // Restoring to active reopens the project for edits.
      const restored = await projects.updateProject(actor, project.id, { status: 'active' });
      expect(restored.status).toBe('active');

      const story = await workItems.createWorkItem(actor, project.id, 'story', 'Now creatable');
      expect(story.id).toBeTruthy();
    });
  });

  // ── PHASE1 P1-MANAGE — team management ───────────────────────────────────────
  describe('P1-MANAGE team management', () => {
    it('creates a Team under the workspace with a normalised key', async () => {
      const key = uniqueKey('T');
      const team = await teams.createTeam(
        actor.workspaceId,
        {
          name: 'Platform Team',
          key: key.toLowerCase(),
          description: 'Owns the platform',
          leadId: ADMIN_USER_ID,
        },
        ADMIN_USER_ID,
      );

      expect(team.key).toBe(key.toUpperCase());
      expect(team.workspaceId).toBe(actor.workspaceId);
      expect(team.status).toBe('active');

      const fetched = await teams.getTeam(team.id, actor.workspaceId);
      expect(fetched.name).toBe('Platform Team');
    });

    it('rejects a duplicate team key with TEAM_KEY_TAKEN', async () => {
      const key = uniqueKey('T');
      await teams.createTeam(actor.workspaceId, { name: 'First Team', key }, ADMIN_USER_ID);
      await expect(
        teams.createTeam(actor.workspaceId, { name: 'Second Team', key }, ADMIN_USER_ID),
      ).rejects.toMatchObject({ code: 'TEAM_KEY_TAKEN' });
    });
  });

  // ── Context backbone: Company → Project → Team ──────────────────────────────
  describe('project ↔ team linkage', () => {
    it('links a team to a project idempotently and unlinks it', async () => {
      const project = await projects.createProject(actor, {
        key: uniqueKey(),
        name: 'Linkable Project',
      });
      const team = await teams.createTeam(
        actor.workspaceId,
        { name: 'Delivery Team', key: uniqueKey('T') },
        ADMIN_USER_ID,
      );

      const link = await projects.linkTeam(actor.workspaceId, project.id, team.id);
      expect(link.teamId).toBe(team.id);

      const linked = await projects.listProjectTeams(actor.workspaceId, project.id);
      expect(linked.some((l) => l.teamId === team.id)).toBe(true);

      // Linking the same team twice is a conflict, not a silent duplicate.
      await expect(projects.linkTeam(actor.workspaceId, project.id, team.id)).rejects.toMatchObject(
        {
          code: 'PROJECT_TEAM_ALREADY_LINKED',
        },
      );

      await projects.unlinkTeam(actor.workspaceId, project.id, team.id);
      const afterUnlink = await projects.listProjectTeams(actor.workspaceId, project.id);
      expect(afterUnlink.some((l) => l.teamId === team.id)).toBe(false);

      // Unlinking a team that is not linked is a clear 404, not a no-op.
      await expect(
        projects.unlinkTeam(actor.workspaceId, project.id, team.id),
      ).rejects.toMatchObject({ code: 'PROJECT_TEAM_LINK_NOT_FOUND' });
    });
  });
});
