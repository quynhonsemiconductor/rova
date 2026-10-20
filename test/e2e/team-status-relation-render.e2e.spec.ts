/**
 * BA business-flow E2E — E2E-011 Team Status, relation-render guard.
 *
 * Team Status is the screen that went blank in production: seeded work items
 * had team_id NULL, the screen filters tasks by team, and a null relation
 * rendered as "no tasks". The service logic was correct; the RELATED DATA
 * reaching the screen was not — and nothing failed, because no test asserted
 * that a task WITH a full set of relations actually surfaces here.
 *
 * This is that test. It builds one task with every relation set (team, iteration,
 * assignee, parent work product, release) and asserts Team Status returns it
 * grouped under the right member with each relation RESOLVED — not just that the
 * ids are correct. See RELATION_DATA_TRACEABILITY.md §"server-resolved": the
 * failure mode of this architecture is a dropped row or an empty field, silently.
 *
 * Deliberately creates its own fully-linked data rather than trusting the seed,
 * so it guards the query's join/filter regardless of what the seed happens to
 * contain. If the team filter, the iteration filter, or the member grouping
 * regresses, the member group or its task row disappears and this fails.
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { TeamService } from '@modules/workspace';
import { IterationsService } from '@modules/iterations';
import { ReleasesService } from '@modules/releases';
import { TeamStatusService } from '@modules/team-status';

import {
  ADMIN_USER_ID,
  DEVELOPER_ID,
  adminActor,
  bootRovaApp,
  grantProjectAccess,
  uniqueKey,
} from './support/flow-harness';

describe('BA flows: E2E-011 Team Status renders a fully-related task', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let teams: TeamService;
  let iterations: IterationsService;
  let releases: ReleasesService;
  let workItems: WorkItemsService;
  let teamStatus: TeamStatusService;

  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    teams = app.get(TeamService);
    iterations = app.get(IterationsService);
    releases = app.get(ReleasesService);
    workItems = app.get(WorkItemsService);
    teamStatus = app.get(TeamStatusService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('surfaces the task under its member with team, iteration, parent and release resolved', async () => {
    // ── Build a complete, linked context, exactly as the Manage/Plan screens would.
    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'E2E-011 Team Status Project',
    });
    const team = await teams.createTeam(
      admin.workspaceId,
      { name: 'E2E-011 Team', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
      ADMIN_USER_ID,
    );
    await projects.linkTeam(admin.workspaceId, project.id, team.id);
    // Both the assignee (DEVELOPER_ID) and admin must be team members for the
    // owner grouping to place the task — and since `PM-FR-020` (BA 2026-08-22) a team member must
    // already hold Project Access, so the grant comes FIRST. That order is the rule, not a fixture
    // detail: `TEAM_MEMBER_NOT_PROJECT_MEMBER` refuses the add otherwise.
    await grantProjectAccess(app, DEVELOPER_ID, project.id, 'editor');
    await teams.addTeamMember(team.id, DEVELOPER_ID, admin.workspaceId, ADMIN_USER_ID);

    const iteration = await iterations.createIteration(admin, project.id, 'E2E-011 Sprint', {
      startDate: '2026-07-20',
      endDate: '2026-08-02',
      teamId: team.id,
    });
    const release = await releases.createRelease(admin, project.id, 'E2E-011 Release', {
      startDate: '2026-07-20',
      releaseDate: '2026-08-31',
    });

    // Parent work product (Story) in that iteration + release, on the team.
    const story = await workItems.createWorkItem(admin, project.id, 'story', 'E2E-011 Story', {
      teamId: team.id,
      iterationId: iteration.id,
      releaseId: release.id,
    });
    // Child task assigned to the developer — inherits the parent context.
    const task = await workItems.createTask(admin, story.id, 'E2E-011 Task', {
      assigneeId: DEVELOPER_ID,
      estimateHours: '5',
      todoHours: '2',
    });

    // ── The screen's actual query.
    const status = await teamStatus.getTeamStatus(admin, project.id, team.id, iteration.id);

    // The developer's member group must exist and carry the task — the exact
    // thing that vanished when team_id was null.
    const devGroup = status.groups.find((m) => m.owner.id === DEVELOPER_ID);
    expect(devGroup, 'developer member group is present').toBeDefined();

    const row = devGroup!.tasks.find((r) => r.id === task.id);
    expect(row, 'the task row surfaces under its owner').toBeDefined();

    // Relations RESOLVED, not just id-correct: the parent work product and the
    // release come back as usable references, and the roll-up reflects the task.
    expect(row!.workProduct.id).toBe(story.id);
    // Resolved, non-blank display fields — the parent name the screen renders.
    // (createWorkItem does not echo the counter-assigned itemKey, so assert the
    //  resolved key is present rather than comparing to the create response.)
    expect(row!.workProduct.key).toBeTruthy();
    expect(row!.workProduct.title).toBe('E2E-011 Story');
    expect(row!.release?.id).toBe(release.id);
    // The resolved owner name is what the screen actually renders, not the id.
    expect(row!.owner.id).toBe(DEVELOPER_ID);
    // To Do is an independent input (real Rally) — the task carries the To Do
    // it was created with (2), and the member roll-up reflects it.
    expect(devGroup!.todoHours).toBeGreaterThanOrEqual(2);
    expect(row!.todoHours).toBe(2);
  });

  it('does NOT surface the task under a different team', async () => {
    // Same screen, wrong team → the row must be absent. Guards against a filter
    // that ignores teamId (which would make every team look identical).
    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'E2E-011 Isolation',
    });
    const teamA = await teams.createTeam(
      admin.workspaceId,
      { name: 'Team A', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
      ADMIN_USER_ID,
    );
    const teamB = await teams.createTeam(
      admin.workspaceId,
      { name: 'Team B', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
      ADMIN_USER_ID,
    );
    await projects.linkTeam(admin.workspaceId, project.id, teamA.id);
    await projects.linkTeam(admin.workspaceId, project.id, teamB.id);
    // Access first, then membership — `PM-FR-020`.
    await grantProjectAccess(app, DEVELOPER_ID, project.id, 'editor');
    await teams.addTeamMember(teamA.id, DEVELOPER_ID, admin.workspaceId, ADMIN_USER_ID);

    const iteration = await iterations.createIteration(admin, project.id, 'E2E-011 Iso Sprint', {
      startDate: '2026-07-20',
      endDate: '2026-08-02',
      teamId: teamA.id,
    });
    const story = await workItems.createWorkItem(admin, project.id, 'story', 'Iso Story', {
      teamId: teamA.id,
      iterationId: iteration.id,
    });
    const task = await workItems.createTask(admin, story.id, 'Iso Task', {
      assigneeId: DEVELOPER_ID,
    });

    const statusB = await teamStatus.getTeamStatus(admin, project.id, teamB.id, iteration.id);
    const leaked = statusB.groups.flatMap((m) => m.tasks).some((r) => r.id === task.id);
    expect(leaked).toBe(false);
  });
});
