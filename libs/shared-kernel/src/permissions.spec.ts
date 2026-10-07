import { describe, expect, it } from 'vitest';
import { permissionGrants } from './permissions';
import {
  ACCESS_LEVEL_PERMISSIONS,
  PERMISSION,
  PERMISSION_TIER,
  PROJECT_ACCESS_LEVEL,
  ROLE_PERMISSIONS,
  isProjectAccessLevel,
  isProjectTierPermission,
  type Permission,
} from '../../../db/permissions.catalog';

describe('permissionGrants (shared wildcard-aware check)', () => {
  it('returns false for empty / missing permissions', () => {
    expect(permissionGrants(undefined, 'work_item:edit')).toBe(false);
    expect(permissionGrants([], 'work_item:edit')).toBe(false);
  });

  it('grants everything on the workspace:* wildcard', () => {
    expect(permissionGrants(['workspace:*'], 'work_item:edit')).toBe(true);
    expect(permissionGrants(['workspace:*'], 'project:delete')).toBe(true);
    expect(permissionGrants(['workspace:*'], 'release:edit')).toBe(true);
  });

  it('matches an exact permission code', () => {
    expect(permissionGrants(['work_item:edit', 'project:view'], 'work_item:edit')).toBe(true);
    expect(permissionGrants(['work_item:edit'], 'work_item:delete')).toBe(false);
  });

  it('honours the namespace ns:* wildcard (the branch the main guard was missing)', () => {
    expect(permissionGrants(['work_item:*'], 'work_item:edit')).toBe(true);
    expect(permissionGrants(['work_item:*'], 'work_item:delete')).toBe(true);
    // a different namespace is NOT granted by work_item:*
    expect(permissionGrants(['work_item:*'], 'project:edit')).toBe(false);
  });

  it('denies when nothing matches', () => {
    expect(permissionGrants(['work_item:view'], 'release:edit')).toBe(false);
  });
});

describe('PERMISSION_TIER (workspace vs project scope)', () => {
  const WORKSPACE_TIER: readonly Permission[] = [
    PERMISSION.WORKSPACE_ALL,
    PERMISSION.WORKSPACE_VIEW,
    PERMISSION.WORKSPACE_CREATE,
    PERMISSION.WORKSPACE_EDIT,
    PERMISSION.WORKSPACE_DELETE,
    PERMISSION.USERS_INVITE,
    PERMISSION.USERS_REMOVE,
    PERMISSION.USERS_ASSIGN_ROLE,
    // Machine credentials are a workspace-wide concern: the question it answers — "what still has
    // access after someone leaves" — cannot be answered per project (migration 0125).
    PERMISSION.API_TOKEN_MANAGE_ALL,
    PERMISSION.ROLES_VIEW,
    PERMISSION.ROLES_EDIT,
    PERMISSION.TEAMS_CREATE,
    PERMISSION.TEAMS_EDIT,
    PERMISSION.TEAMS_MANAGE_MEMBERS,
    PERMISSION.AUDIT_VIEW,
    PERMISSION.SCM_MANAGE,
    PERMISSION.PROJECT_CREATE,
  ];

  it('classifies every catalogued permission', () => {
    for (const code of Object.values(PERMISSION)) {
      expect(PERMISSION_TIER[code], `missing tier for ${code}`).toBeDefined();
    }
  });

  it('marks exactly the workspace-tier permissions as workspace', () => {
    for (const code of Object.values(PERMISSION)) {
      const expected = WORKSPACE_TIER.includes(code) ? 'workspace' : 'project';
      expect(PERMISSION_TIER[code], code).toBe(expected);
    }
  });

  it('everything acting on an existing project is project-tier', () => {
    // work items, iterations, releases, milestones, quality, team-status and
    // project edit/archive/restore/delete/manage_members are all per-project.
    expect(isProjectTierPermission(PERMISSION.WORK_ITEM_CREATE)).toBe(true);
    expect(isProjectTierPermission(PERMISSION.ITERATION_VIEW)).toBe(true);
    expect(isProjectTierPermission(PERMISSION.PROJECT_DELETE)).toBe(true);
    expect(isProjectTierPermission(PERMISSION.PROJECT_EDIT)).toBe(true);
    // minting a project (no instance yet) and workspace admin are NOT.
    expect(isProjectTierPermission(PERMISSION.PROJECT_CREATE)).toBe(false);
    expect(isProjectTierPermission(PERMISSION.USERS_ASSIGN_ROLE)).toBe(false);
  });
});

describe('per-Project access levels', () => {
  it('has a permission set for every level, and no level without one', () => {
    // Guards the shape both ways: a level added to the constant without a set would resolve
    // `undefined` and spread into an empty permission array, i.e. silently No Access.
    expect(Object.keys(ACCESS_LEVEL_PERMISSIONS).sort()).toEqual([...PROJECT_ACCESS_LEVEL].sort());
  });

  it('is exactly admin and editor — no viewer', () => {
    /**
     * The BA's three-level model: Workspace Admin plus per-Project `admin` or `editor`, with No
     * Access implicit when no row exists. A `viewer` level was added by ruling and removed again on
     * the BA's instruction (migrations 0113 then 0115), so this asserts the DECISION rather than
     * merely the current contents — a re-add has to change this line and argue for it.
     *
     * Real Rally does have Viewer, and the reasons are in `permissions.catalog.ts`. That is a known
     * divergence, not a gap to close quietly.
     */
    expect([...PROJECT_ACCESS_LEVEL]).toEqual(['admin', 'editor']);
  });

  it('recognises exactly the catalogued levels', () => {
    for (const level of PROJECT_ACCESS_LEVEL) expect(isProjectAccessLevel(level)).toBe(true);
    // The values a `project_members` row can otherwise hold, and the shapes a bad cast produces.
    for (const other of [null, undefined, '', 'workspace_admin', 'project_admin', 'ADMIN', 3])
      expect(isProjectAccessLevel(other)).toBe(false);
  });

  it('hides the Timeboxes surface from an Editor without taking away the timebox READ', () => {
    /**
     * §3.2 marks `Timeboxes / Iterations` **Hidden** for an Editor and `Create, View, Edit,
     * Delete` for Admin, while the row directly above it grants the Editor `Iteration Status |
     * View and update in assigned Teams`. `iteration:view` gated BOTH surfaces, so an Editor read
     * the whole timebox inventory on a screen the BA hides (RBE-09 / P23-08 / P01-11).
     *
     * Both directions, because either one alone passes for the wrong reason. Asserting only the
     * refusal would also pass if `iteration:view` had simply been revoked from the Editor — which
     * would 403 Iteration Status, the Backlog's iteration filter, Team Status and Quality, all of
     * which read `GET /iterations`. Asserting only the grant would pass on today's pre-split
     * catalogue.
     */
    expect(ACCESS_LEVEL_PERMISSIONS.editor).not.toContain(PERMISSION.TIMEBOX_VIEW);
    expect(ACCESS_LEVEL_PERMISSIONS.editor).toContain(PERMISSION.ITERATION_VIEW);
    expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain(PERMISSION.TIMEBOX_VIEW);
    expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain(PERMISSION.ITERATION_VIEW);

    /**
     * A NAMESPACE OF ITS OWN, and these three lines are why that matters.
     *
     * `iteration:*` — which a custom role can carry — must NOT reach the administration surface,
     * because §3.2 hides it independently of iteration CRUD. Its own namespace wildcard does. And
     * the retired string `iteration:manage` (deleted from every role by migration 0048, when the
     * coarse create+edit+delete bundle was split) must not grant it either: recycling that code
     * would let a pre-0048 role or backup silently open a screen nobody granted.
     */
    expect(permissionGrants(['iteration:*'], PERMISSION.TIMEBOX_VIEW)).toBe(false);
    expect(permissionGrants(['timebox:*'], PERMISSION.TIMEBOX_VIEW)).toBe(true);
    expect(permissionGrants(['iteration:manage'], PERMISSION.TIMEBOX_VIEW)).toBe(false);
    // …and the Editor's own code does not, which is the whole split.
    expect(permissionGrants([PERMISSION.ITERATION_VIEW], PERMISSION.TIMEBOX_VIEW)).toBe(false);
  });

  it('report:export goes only where report:view does, and never to an Editor (Phase 7 R1/R4)', () => {
    // EXPORT IMPLIES VIEW: a CSV is the report off-platform, so nobody may hold it without the screen.
    // The export routes also re-check `report:view` in the controller, so this is the catalogue half.
    const sets = [
      ...Object.values(ROLE_PERMISSIONS),
      ...Object.values(ACCESS_LEVEL_PERMISSIONS),
    ] as ReadonlyArray<readonly string[]>;
    for (const permissions of sets) {
      if (permissions.includes(PERMISSION.REPORT_EXPORT)) {
        expect(permissions).toContain(PERMISSION.REPORT_VIEW);
      }
    }
    expect(ACCESS_LEVEL_PERMISSIONS.admin).toContain(PERMISSION.REPORT_EXPORT);
    expect(ACCESS_LEVEL_PERMISSIONS.editor).not.toContain(PERMISSION.REPORT_EXPORT);
  });

  it('gives Admin no permission an Editor lacks unless it is deliberate', () => {
    // Admin ⊇ Editor. The tiers derive from ROLE_PERMISSIONS, so this catches a hand-edit that
    // removes a code from Admin while leaving it with Editor — which would make "promote to Admin"
    // a partial DEMOTION, the least expected outcome of an access change.
    const admin = new Set<string>(ACCESS_LEVEL_PERMISSIONS.admin);
    for (const code of ACCESS_LEVEL_PERMISSIONS.editor) {
      expect(admin.has(code), `editor holds ${code} but admin does not`).toBe(true);
    }
  });
});
