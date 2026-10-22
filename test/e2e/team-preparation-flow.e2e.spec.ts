/**
 * BA business-flow E2E — E2E-002 "Admin prepares team and user for work management".
 *
 * This flow had NO automated coverage, and its absence is why the manual BA run
 * collapsed: tracker checkpoints 00, 01 and 04 were all blocked by "Team is not
 * linked to this project" (gaps DEV-003 / DEV-007). The team↔project link was
 * missing from the environment and nothing failed until a human tried to create
 * a work item.
 *
 * NOTE on numbering — the tracker's execution checkpoints (two digits, in
 * BUSINESS_E2E_TEST_TRACKER.xlsx) and the business flows (three digits, in
 * E2E_BUSINESS_FLOW_COVERAGE.md) are DIFFERENT schemes that look alike. Only
 * three-digit flow ids are written in the citable form in these specs, so the
 * traceability matrix can be extracted mechanically without false matches.
 *
 * Encodes the business rules verbatim from
 * 04_Developement_tracking/Phase 1/08_Manage_Projects_Teams_Users/SRS.md §2A:
 *
 *   - "a Team must be linked to at least one active Project before it can be
 *      selected in Backlog/Create/Detail flows"
 *   - "User project access is derived from team membership. The User management
 *      screen must not assign projects directly to a user."
 *   - "Work Item Project and Team must be a valid pair. If a user selects
 *      Project NXP, the Team dropdown can only show teams linked to NXP."
 *   - TEAM-FR-006 "Saving creates team and links it to selected project."
 *   - TEAM-FR-004 "Team key is normalized uppercase and validated unique."
 *
 * Each test asserts a rule that a wrong implementation would actually violate —
 * an unlinked team must be REJECTED, a cross-project team must be REJECTED, and
 * the prepared context must be USABLE by the Backlog. Asserting only that calls
 * succeed would have passed against the very state that blocked the BA run.
 *
 * NOT duplicated here: team key normalisation (TEAM-FR-004), duplicate-key
 * rejection, and project↔team link/unlink idempotency (TEAM-FR-006) are already
 * proven by workspace-foundation-flow.e2e.spec.ts, which asserts strictly more
 * in each case. This spec starts where that one stops — at the rules that only
 * matter once a team is actually being USED for work management.
 *
 * Drives the REAL application services against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { TeamService } from '@modules/workspace';

import {
  ADMIN_USER_ID,
  ALL,
  DEVELOPER_ID,
  VIEWER_ID,
  adminActor,
  bootRovaApp,
  uniqueKey,
} from './support/flow-harness';

describe('BA flows: E2E-002 admin prepares team and user for work management', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let teams: TeamService;
  let workItems: WorkItemsService;
  /** Grants the project access the 2026-08-21 rule now requires BEFORE a roster row. */
  let access: AccessService;

  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    projects = app.get(ProjectsService);
    teams = app.get(TeamService);
    workItems = app.get(WorkItemsService);
    access = app.get(AccessService);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A project + team pair prepared exactly as the Manage screens would. */
  async function prepareLinkedContext() {
    const project = await projects.createProject(admin, {
      key: uniqueKey(),
      name: 'E2E-002 Delivery Project',
    });
    const team = await teams.createTeam(
      admin.workspaceId,
      { name: 'E2E-002 Team', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
      ADMIN_USER_ID,
    );
    await projects.linkTeam(admin.workspaceId, project.id, team.id);
    return { project, team };
  }

  describe('rule — a team must be linked before it can be used (SRS §2A)', () => {
    // THE regression guard for DEV-003 / DEV-007. An unlinked team must be
    // rejected; if this ever silently succeeds, work items acquire a team their
    // project does not recognise and the Backlog/Team Status screens diverge.
    it('rejects a work item whose team is NOT linked to the project', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-002 Unlinked Guard',
      });
      const strangerTeam = await teams.createTeam(
        admin.workspaceId,
        { name: 'E2E-002 Unlinked Team', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
        ADMIN_USER_ID,
      );
      // Deliberately NOT linked to `project`.

      await expect(
        workItems.createWorkItem(admin, project.id, 'story', 'Should be rejected', {
          teamId: strangerTeam.id,
        }),
      ).rejects.toThrow(/PROJECT_TEAM_LINK_NOT_FOUND|not linked/i);
    });

    it('rejects a team linked to a DIFFERENT project (valid Project–Team pair rule)', async () => {
      const { team: teamOfA } = await prepareLinkedContext();
      const projectB = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'E2E-002 Other Project',
      });

      await expect(
        workItems.createWorkItem(admin, projectB.id, 'story', 'Cross-project team', {
          teamId: teamOfA.id,
        }),
      ).rejects.toThrow(/PROJECT_TEAM_LINK_NOT_FOUND|not linked/i);
    });

    it('accepts the work item once the team IS linked', async () => {
      const { project, team } = await prepareLinkedContext();

      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Linked team ok', {
        teamId: team.id,
      });

      expect(story.teamId).toBe(team.id);
      expect(story.projectId).toBe(project.id);
    });
  });

  describe('steps 4–5 — the prepared context is usable by the Backlog', () => {
    // This is the assertion that would have caught the missing team_id seeding:
    // the Backlog filters work items by team, so a context that is "prepared"
    // but produces an empty Backlog is not actually prepared.
    it("returns the team's work item when the Backlog is filtered by that team", async () => {
      const { project, team } = await prepareLinkedContext();
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Backlog visible', {
        teamId: team.id,
      });

      const backlog = await workItems.listBacklog(admin, project.id, { teamId: team.id }, ALL);

      expect(backlog.data.map((w) => w.id)).toContain(story.id);
    });

    it("does NOT leak another team's work item into the filtered Backlog", async () => {
      const { project, team } = await prepareLinkedContext();
      const otherTeam = await teams.createTeam(
        admin.workspaceId,
        { name: 'E2E-002 Other Team', key: uniqueKey('T'), leadId: ADMIN_USER_ID },
        ADMIN_USER_ID,
      );
      await projects.linkTeam(admin.workspaceId, project.id, otherTeam.id);

      const mine = await workItems.createWorkItem(admin, project.id, 'story', 'Mine', {
        teamId: team.id,
      });
      const theirs = await workItems.createWorkItem(admin, project.id, 'story', 'Theirs', {
        teamId: otherTeam.id,
      });

      const backlog = await workItems.listBacklog(admin, project.id, { teamId: team.id }, ALL);
      const ids = backlog.data.map((w) => w.id);

      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });
  });

  /**
   * ORDER REVERSED, 2026-08-21 — read this before "fixing" either half.
   *
   * §2A says "User project access is derived from team membership", and this block used to prove it by
   * adding a workspace user with NO project access straight to a linked team. The BA's report of
   * 2026-08-21 states the opposite for that write: the Add Member modal "lists only active users who
   * already belong to the selected Project", and "Backend validation must also reject adding a user
   * who does not belong to the Project" (`TEAM_MEMBER_NOT_PROJECT_MEMBER`).
   *
   * The two cannot both hold on `addTeamMember`, and the newer instruction wins — the same precedence
   * this repo applied to the defect-delete and Rollup reversals. What survives of §2A is the DERIVING
   * itself, on the path the BA's own E2E-002 uses: `createTeam` with `memberUserIds` still grants
   * project access through RBE-06 ("Create Team under a Project and select one existing user as
   * Editor"), and a roster row still implies access for everyone it admits. What changed is that an
   * EXISTING team can no longer be the first place a user meets a project: grant access, then staff
   * the team.
   *
   * PUT TO THE BA. If they want §2A's order restored, the refusal in `TeamService.addTeamMember` is
   * the one predicate to remove, and this block goes back to asserting the add succeeds.
   */
  describe('step 3 — project access comes FIRST, then team membership (2026-08-21)', () => {
    it('refuses a workspace user who has no access to the team’s project', async () => {
      const { team } = await prepareLinkedContext();

      await expect(
        teams.addTeamMember(team.id, DEVELOPER_ID, admin.workspaceId, ADMIN_USER_ID),
      ).rejects.toThrow(/TEAM_MEMBER_NOT_PROJECT_MEMBER|does not belong/);

      const roster = await teams.listTeamMembers(team.id, admin.workspaceId);
      expect(roster.map((m) => m.userId)).not.toContain(DEVELOPER_ID);
    });

    it('admits them once they hold project access, and the roster row keeps deriving it', async () => {
      const { project, team } = await prepareLinkedContext();
      await access.grantProjectAccess({
        workspaceId: admin.workspaceId,
        projectId: project.id,
        userId: DEVELOPER_ID,
        accessLevel: 'editor',
        actorId: ADMIN_USER_ID,
        // An ordinary user, so the §2.1 branch never applies; stated because the parameter is required.
        onWorkspaceAdmin: 'refuse',
      });

      const member = await teams.addTeamMember(
        team.id,
        DEVELOPER_ID,
        admin.workspaceId,
        ADMIN_USER_ID,
      );

      expect(member.userId).toBe(DEVELOPER_ID);
      const roster = await teams.listTeamMembers(team.id, admin.workspaceId);
      expect(roster.map((m) => m.userId)).toContain(DEVELOPER_ID);
    });

    it('writes NO Project Access when a team is created with members (PM-FR-021)', async () => {
      // The last of §2A to go. `PM-FR-021` (2026-08-22): "Adding or removing a Team member never
      // creates or changes Project Access" — and the same commit makes candidates users who already
      // hold a level, so nothing is left for a roster row to grant. This case asserted the opposite
      // (RBE-06 deriving at create time) until that ruling.
      const { project } = await prepareLinkedContext();
      const before = await access.getProjectAccessLevel(admin.workspaceId, VIEWER_ID, project.id);
      expect(before).toBeNull();

      const team = await teams.createTeam(
        admin.workspaceId,
        {
          name: `E2E-002 No-grant Team ${uniqueKey('T')}`,
          key: uniqueKey('T'),
          projectIds: [project.id],
          memberUserIds: [VIEWER_ID],
        },
        ADMIN_USER_ID,
      );

      const roster = await teams.listTeamMembers(team.id, admin.workspaceId);
      expect(roster.map((m) => m.userId)).toContain(VIEWER_ID);
      // Membership written, access untouched.
      expect(
        await access.getProjectAccessLevel(admin.workspaceId, VIEWER_ID, project.id),
      ).toBeNull();
    });

    it('refuses a user who is not a member of the owning workspace', async () => {
      const { team } = await prepareLinkedContext();
      const stranger = '00000000-0000-7000-8000-0000000009ff';

      await expect(
        teams.addTeamMember(team.id, stranger, admin.workspaceId, ADMIN_USER_ID),
      ).rejects.toThrow();
    });
  });
});
