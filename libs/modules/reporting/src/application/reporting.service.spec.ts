import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedException } from '@platform';
import type { JwtPayload } from '@platform';
import type { AccessService } from '@modules/access';
import type { PreliminaryEstimateMapService } from '@modules/portfolio';
import { ReportingService } from './reporting.service';
import type {
  IReportingRepository,
  IterationRow,
  ReleaseRow,
} from '../domain/ports/reporting.repository';
import type { ReleaseChild, ReleaseFeature } from '../domain/release-tracking';
import { frozenSeriesScope, isEmptyTeamScope, type TeamScope } from '../domain/report-scope';
import type { StoredSnapshot, StoredSplitEvent } from '../domain/burndown';

/**
 * The team half of report authorization (BA ruling, 2026-08-17).
 *
 * What is pinned here is the SCOPE each report is asked for, because that is the whole boundary:
 * "Null means Project Backlog, accessible only to Workspace Admin and Project Admin. Editor …
 * cannot access team-less items. Enforce this consistently in API queries, lists, reports, search,
 * pickers and direct URLs."
 *
 * Three collaborators, three different jobs, and this spec deliberately fakes only two of them:
 *  • `AccessService` decides what the reader MAY see (`resolveTeamScope` / `assertTeamInScope`) —
 *    faked, since its own rules are pinned by `access.service.spec.ts`;
 *  • `ReportingService` intersects that with what they ASKED for — the subject;
 *  • the repository turns a scope into SQL — faked here, and its predicates are asserted for real
 *    (rendered, without a database) in `infrastructure/persistence/team-scope.sql.spec.ts`. The two
 *    specs together are what make this a boundary rather than a filter: one proves the right scope
 *    is passed, the other proves a non-`all` scope always becomes a WHERE clause.
 */

const WS = 'ws-1';
const PROJECT = 'proj-1';
const MINE_A = 'team-a';
const MINE_B = 'team-b';
const THEIRS = 'team-z';

// A principal's `permissions` array is inert (CLAUDE.md): only a real assignment grants anything,
// which is why the fake `AccessService` below is what decides this reader's scope.
const admin = { sub: 'u-admin', workspaceId: WS } as unknown as JwtPayload;
const editor = { sub: 'u-editor', workspaceId: WS } as unknown as JwtPayload;

const iteration = (over: Partial<IterationRow> = {}): IterationRow => ({
  id: 'it-1',
  projectId: PROJECT,
  teamId: null,
  timeboxGroupId: 'grp-1',
  name: 'Sprint 26.1',
  startDate: '2026-06-01',
  endDate: '2026-06-12',
  ...over,
});

const release: ReleaseRow = {
  id: 'rel-1',
  workspaceId: WS,
  projectId: PROJECT,
  name: 'v2.0',
  startDate: '2026-06-01',
  releaseDate: '2026-06-30',
};

const feature = (over: Partial<ReleaseFeature> = {}): ReleaseFeature & { state: string } => ({
  id: 'f-1',
  itemKey: 'FE-1',
  name: 'A feature',
  state: 'defined',
  releaseId: release.id,
  teamId: MINE_A,
  teamName: 'Team A',
  rank: 'a',
  plannedStartDate: null,
  plannedEndDate: null,
  refinedPoints: 0,
  refinedCount: 0,
  preliminaryPoints: 0,
  preliminaryCount: 0,
  ...over,
});

const child = (over: Partial<ReleaseChild> = {}): ReleaseChild => ({
  id: 'c-1',
  itemKey: 'US-1',
  type: 'story',
  title: 'A story',
  featureId: null,
  releaseId: release.id,
  releaseName: release.name,
  teamId: MINE_A,
  teamName: 'Team A',
  planEstimate: 5,
  acceptedEquivalent: false,
  scheduleState: 'defined',
  ...over,
});

/** Every scope the service handed the repository during one call, by method name. */
type ScopeLog = Array<{ method: string; scope: TeamScope }>;

/**
 * Frozen rows as `iteration_daily_snapshots` actually holds them: one MEASURED row per scope, the
 * `team_id IS NULL` one measured over the whole iteration rather than summed (migration 0093).
 *
 * The All Teams row is deliberately NOT 40 + 25: a reader who was served it would see other Teams'
 * measurements, which is what makes the multi-Team case below a disclosure rather than a rounding
 * question.
 */
const STORED_SNAPSHOTS: Array<{ teamId: string | null } & StoredSnapshot> = [
  {
    teamId: null,
    date: '2026-06-01',
    remainingToDo: 100,
    acceptedPoints: 9,
    capturedAt: null,
    endOfDay: true,
  },
  {
    teamId: MINE_A,
    date: '2026-06-01',
    remainingToDo: 40,
    acceptedPoints: 3,
    capturedAt: null,
    endOfDay: true,
  },
  {
    teamId: MINE_B,
    date: '2026-06-01',
    remainingToDo: 25,
    acceptedPoints: 2,
    capturedAt: null,
    endOfDay: true,
  },
];

/**
 * One stored Split Event, the shape `story_splits` hands the report layer (SU-08).
 *
 * Two sides with DIFFERENT Plan Estimates and a non-zero retained Actual, deliberately: a fixture
 * where both sides carried the same number could not tell `splitOutMarkers` from `carryInMarkers`, and
 * one with `actualHoursAtSplit: 0` could not tell the target's mandated `0h` opening from a value
 * copied off the event.
 */
const SPLIT_EVENTS: StoredSplitEvent[] = [
  {
    splitId: 'split-1',
    sourceIterationId: 'it-1',
    targetIterationId: 'it-2',
    sourceMarkerDate: '2026-06-10',
    targetMarkerDate: '2026-06-16',
    unfinishedStoryId: 'wi-unfinished',
    unfinishedStoryKey: 'US-901',
    unfinishedPlanEstimate: 2,
    continuedStoryId: 'wi-continued',
    continuedStoryKey: 'US-900',
    continuedPlanEstimate: 3,
    movedTodoHours: 7,
    actualHoursAtSplit: 5,
  },
];

function harness(opts: {
  /** `null` = unrestricted (Workspace Admin / project admin); otherwise the reader's own Teams. */
  teams: string[] | null;
  features?: Array<ReleaseFeature & { state: string }>;
  children?: ReleaseChild[];
  iteration?: IterationRow;
}) {
  const scopes: ScopeLog = [];
  const log = <T>(method: string, scope: TeamScope, value: T): T => {
    scopes.push({ method, scope });
    return value;
  };

  const access = {
    resolveTeamScope: vi.fn(async () =>
      opts.teams === null
        ? ({ unrestricted: true } as const)
        : ({ unrestricted: false, teamIds: opts.teams } as const),
    ),
    /** The real refusal, so the spec asserts the code the client branches on. */
    assertTeamInScope: vi.fn(async (_ws: string, _u: string, _p: string, teamId: string | null) => {
      if (opts.teams === null) return;
      if (opts.teams.length === 0) {
        throw new PermissionDeniedException('EDITOR_NO_TEAM_SCOPE', 'no team');
      }
      if (teamId === null) {
        throw new PermissionDeniedException('PROJECT_BACKLOG_ADMIN_ONLY', 'backlog');
      }
      if (!opts.teams.includes(teamId)) {
        throw new PermissionDeniedException('TEAM_NOT_IN_SCOPE', 'not yours');
      }
    }),
  };

  const repo: IReportingRepository = {
    getWorkspaceSettings: vi.fn(async () => ({ timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5] })),
    getProjectName: vi.fn(async () => 'NextGen Platform'),
    getTeamName: vi.fn(async () => 'Team A'),
    findIteration: vi.fn(async () => opts.iteration ?? iteration()),
    // Mirrors the real repository's empty-scope short-circuit, which is where a reader with no Team
    // gets their empty state. The SQL half is pinned in team-scope.sql.spec.ts.
    findTimeboxSiblings: vi.fn(async (_ws, _p, _g, scope: TeamScope) =>
      log(
        'findTimeboxSiblings',
        scope,
        isEmptyTeamScope(scope) ? [] : [opts.iteration ?? iteration()],
      ),
    ),
    /**
     * Mirrors the real repository: `frozenSeriesScope` picks exactly ONE stored series, or none.
     *
     * Faked at that level on purpose — the alternative is a fake that returns `[]` for everything,
     * which would pass whether or not the service leaked the All Teams row.
     */
    getIterationSnapshots: vi.fn(async (_ws, _ids, scope: TeamScope) => {
      const frozen = frozenSeriesScope(scope);
      const rows =
        frozen === null
          ? []
          : STORED_SNAPSHOTS.filter((r) =>
              frozen.kind === 'team' ? r.teamId === frozen.teamId : r.teamId === null,
            );
      return log(
        'getIterationSnapshots',
        scope,
        rows.map(({ teamId: _teamId, ...row }) => row),
      );
    }),
    // A LIVE count, in the reader's own scope: it is what distinguishes "no scheduled work" from
    // "work exists, the history is unavailable".
    countScheduledWork: vi.fn(async (_ws, _ids, scope: TeamScope) =>
      log('countScheduledWork', scope, isEmptyTeamScope(scope) ? 0 : 3),
    ),
    /**
     * The Split annotations (SU-08). Logged like every other read, so the "every repository read runs
     * in the reader's own scope" assertions above cover them too — a marker leaking another Team's
     * Split onto this chart is the same class of fault as a snapshot row leaking.
     */
    findSplitsBySourceIteration: vi.fn(async (_ws, _ids, scope: TeamScope) =>
      log('findSplitsBySourceIteration', scope, isEmptyTeamScope(scope) ? [] : SPLIT_EVENTS),
    ),
    findSplitsByTargetIteration: vi.fn(async (_ws, _ids, scope: TeamScope) =>
      log('findSplitsByTargetIteration', scope, isEmptyTeamScope(scope) ? [] : SPLIT_EVENTS),
    ),
    findEligibleTimeboxes: vi.fn(async (_ws, _p, scope: TeamScope) =>
      log('findEligibleTimeboxes', scope, []),
    ),
    getVelocityItems: vi.fn(async (_ws, _ids, scope: TeamScope) =>
      log('getVelocityItems', scope, []),
    ),
    getCapacityRecords: vi.fn(async (_ws, _p, _ids, scope: TeamScope) =>
      log('getCapacityRecords', scope, []),
    ),
    getScopedTaskHours: vi.fn(async (_ws, _p, _ids, scope: TeamScope) =>
      log('getScopedTaskHours', scope, []),
    ),
    findRelease: vi.fn(async () => release),
    getReleaseFeatures: vi.fn(async () => opts.features ?? []),
    getReleaseChildren: vi.fn(async () => opts.children ?? []),
    getReleaseBurnupRows: vi.fn(async (_ws, _r, scope: TeamScope) =>
      log('getReleaseBurnupRows', scope, []),
    ),
    findIterationsInWindow: vi.fn(async (_ws, _p, scope: TeamScope) =>
      log('findIterationsInWindow', scope, []),
    ),
    findActiveIterations: vi.fn(async () => []),
    findActiveReleases: vi.fn(async () => []),
    findWorkspacesWithOpenSnapshots: vi.fn(async () => []),
    sumTaskEstimateByTeam: vi.fn(async () => []),
    captureTeamBaselines: vi.fn(async () => undefined),
    sumTeamBaselines: vi.fn(async (_ws, _ids, scope: TeamScope) =>
      log('sumTeamBaselines', scope, null),
    ),
    captureReleaseTeamTarget: vi.fn(async () => undefined),
    findReleaseTeamTarget: vi.fn(async (_ws, _r, scope: TeamScope) =>
      log('findReleaseTeamTarget', scope, null),
    ),
    measureIterationDay: vi.fn(async () => ({ remainingTodo: 0, acceptedPoints: 0 })),
    teamsInIterationScope: vi.fn(async () => []),
    upsertIterationSnapshot: vi.fn(async () => undefined),
    upsertReleaseSnapshot: vi.fn(async () => undefined),
    finalizeSnapshotsBefore: vi.fn(async () => undefined),
  };

  const estimates = {
    forProject: vi.fn(async () => ({
      no_entry: { points: 0, count: 0 },
      xs: { points: 1, count: 1 },
      s: { points: 2, count: 2 },
      m: { points: 3, count: 3 },
      l: { points: 5, count: 5 },
      xl: { points: 8, count: 8 },
    })),
  } as unknown as PreliminaryEstimateMapService;

  const service = new ReportingService(repo, estimates, access as unknown as AccessService);
  return { service, repo, access, scopes };
}

const scopesOf = (scopes: ScopeLog): TeamScope[] => scopes.map((s) => s.scope);

describe('Split markers on the burndown (SU-08 8.2)', () => {
  it('assembles both directions from the Split Events, one marker each', async () => {
    const { service } = harness({ teams: null });
    const report = await service.getIterationBurndown(admin, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    // SPLIT OUT names the placeholder and the Actual the SOURCE retains; CARRY IN names the original
    // and opens its Actual at zero. Same event, two different readings — which is why the service asks
    // for the two directions separately rather than deriving one from the other.
    expect(report.splitOut).toEqual([
      {
        splitId: 'split-1',
        kind: 'split-out',
        date: '2026-06-10',
        storyId: 'wi-unfinished',
        storyKey: 'US-901',
        points: 2,
        todoHours: 7,
        actualHours: 5,
      },
    ]);
    expect(report.carryIn).toEqual([
      {
        splitId: 'split-1',
        kind: 'carry-in',
        date: '2026-06-16',
        storyId: 'wi-continued',
        storyKey: 'US-900',
        points: 3,
        todoHours: 7,
        actualHours: 0,
      },
    ]);
  });

  it('reads BOTH lookups over the whole timebox, in the reader’s own scope', async () => {
    const { service, repo, scopes } = harness({ teams: [MINE_A] });
    await service.getIterationBurndown(editor, { projectId: PROJECT, iterationId: 'it-1' });

    // `iterationIds` is every PARTICIPATING iteration, not the selected one: for All Teams the series
    // is fused across the shared timebox, and a marker sourced from `selected.id` alone would be
    // missing from exactly the view its numbers came from.
    expect(repo.findSplitsBySourceIteration).toHaveBeenCalledWith(WS, ['it-1'], expect.anything());
    expect(repo.findSplitsByTargetIteration).toHaveBeenCalledWith(WS, ['it-1'], expect.anything());
    const marked = scopes.filter((s) => s.method.startsWith('findSplits'));
    expect(marked).toHaveLength(2);
    for (const entry of marked) expect(entry.scope).toEqual({ kind: 'teams', teamIds: [MINE_A] });
  });

  it('is two empty arrays for a reader with no Team, not a leak and not a null', async () => {
    // The empty-scope short-circuit is the same one that empties the series. Empty ARRAYS rather than
    // null, so the SPA maps over one shape whether or not a Split ever happened.
    const { service } = harness({ teams: [] });
    const report = await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    expect(report.splitOut).toEqual([]);
    expect(report.carryIn).toEqual([]);
  });
});

describe('an UNRESTRICTED reader is completely unaffected', () => {
  it('still gets All Teams by default, in every query and in the context label', async () => {
    const { service, scopes } = harness({ teams: null });
    const report = await service.getIterationBurndown(admin, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    expect(scopesOf(scopes).length).toBeGreaterThan(0);
    for (const scope of scopesOf(scopes)) expect(scope).toEqual({ kind: 'all' });
    expect(report.context.teamName).toBe('All Teams');
    expect(report.context.teamId).toBeNull();
  });

  it('still gets a plain selected-Team scope, not a one-element restricted one', async () => {
    // The difference is the Project Backlog: `{ kind: 'team' }` admits a team-agnostic row and a
    // restricted scope must not, so an admin's numbers would move if these two were conflated.
    const { service, scopes } = harness({ teams: null });
    const report = await service.getIterationBurndown(admin, {
      projectId: PROJECT,
      teamId: MINE_A,
      iterationId: 'it-1',
    });

    for (const scope of scopesOf(scopes)) expect(scope).toEqual({ kind: 'team', teamId: MINE_A });
    expect(report.context.teamName).toBe('Team A');
  });

  it('keeps the Project Backlog inside a selected Team on Release Tracking', async () => {
    const { service } = harness({
      teams: null,
      features: [feature({ id: 'f-backlog', teamId: null, teamName: null })],
      children: [],
    });
    const report = await service.getReleaseTracking(admin, {
      projectId: PROJECT,
      releaseId: release.id,
      teamId: MINE_A,
    });
    // `inScope`'s documented rule for an admin, shared with the FROZEN snapshot writer.
    expect(report.summary.direct).toBe(1);
  });
});

describe('a team-restricted reader (Editor)', () => {
  it('is narrowed to their own Teams when they select none', async () => {
    const { service, scopes } = harness({ teams: [MINE_A, MINE_B] });
    const report = await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    for (const scope of scopesOf(scopes)) {
      expect(scope).toEqual({ kind: 'teams', teamIds: [MINE_A, MINE_B] });
    }
    // NOT "All Teams": their default counts neither the other Teams nor the Project Backlog.
    expect(report.context.teamName).toBe('My Teams');
  });

  it('gets a one-element restricted scope for a Team they hold, never `kind: team`', async () => {
    const { service, scopes, access } = harness({ teams: [MINE_A, MINE_B] });
    await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      teamId: MINE_A,
      iterationId: 'it-1',
    });

    expect(access.assertTeamInScope).toHaveBeenCalledWith(WS, editor.sub, PROJECT, MINE_A);
    for (const scope of scopesOf(scopes))
      expect(scope).toEqual({ kind: 'teams', teamIds: [MINE_A] });
  });

  it('is REFUSED a Team they do not hold, not served an empty chart', async () => {
    const { service, scopes } = harness({ teams: [MINE_A] });
    await expect(
      service.getIterationBurndown(editor, {
        projectId: PROJECT,
        teamId: THEIRS,
        iterationId: 'it-1',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_NOT_IN_SCOPE' });
    // Refused BEFORE any measurement was read.
    expect(scopes).toEqual([]);
  });

  it('is refused an iteration owned by another Team, reached by direct URL', async () => {
    const { service } = harness({
      teams: [MINE_A],
      iteration: iteration({ teamId: THEIRS }),
    });
    await expect(
      service.getTeamCapacity(editor, { projectId: PROJECT, iterationId: 'it-1' }),
    ).rejects.toMatchObject({ code: 'TEAM_NOT_IN_SCOPE' });
  });

  it('may still open a SHARED, team-less iteration — a window is not the Project Backlog', async () => {
    const { service } = harness({ teams: [MINE_A], iteration: iteration({ teamId: null }) });
    const report = await service.getTeamCapacity(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });
    expect(report.timebox.iterationId).toBe('it-1');
  });

  it('with NO Team gets the empty state, never an unfiltered read', async () => {
    const { service, scopes } = harness({ teams: [] });
    const report = await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    for (const scope of scopesOf(scopes)) expect(scope).toEqual({ kind: 'teams', teamIds: [] });
    expect(scopesOf(scopes)).not.toContainEqual({ kind: 'all' });
    // No timebox in scope, so nothing was measured and nothing is claimed.
    expect(report.timebox.iterationCount).toBe(0);
    expect(report.hasScheduledWork).toBe(false);
    expect(report.points.every((p) => p.remainingToDo === null)).toBe(true);
  });

  it('excludes the Project Backlog from Release Tracking', async () => {
    const { service } = harness({
      teams: [MINE_A],
      features: [
        feature({ id: 'f-mine', teamId: MINE_A }),
        feature({ id: 'f-backlog', teamId: null, teamName: null }),
        feature({ id: 'f-theirs', teamId: THEIRS, teamName: 'Team Z' }),
      ],
      children: [
        child({ id: 'c-mine', teamId: MINE_A }),
        child({ id: 'c-backlog', teamId: null, teamName: null }),
      ],
    });
    const report = await service.getReleaseTracking(editor, {
      projectId: PROJECT,
      releaseId: release.id,
    });

    expect(report.summary.direct).toBe(1);
    expect(report.rows.map((r) => r.id)).toEqual(['f-mine']);
    // The Unparented bucket and the totals are counted in the SAME scope: one team-less leaf and
    // one foreign Feature are both absent, so `planned` is the 5 points of their own story alone.
    expect(report.summary.unparented).toBe(1);
    expect(report.totals.planned).toBe(5);
  });
});

describe('the scope reaches every report, not just the one that was reviewed', () => {
  const cases: Array<[string, (s: ReportingService) => Promise<unknown>]> = [
    [
      'iteration burndown',
      (s) => s.getIterationBurndown(editor, { projectId: PROJECT, iterationId: 'it-1' }),
    ],
    ['velocity', (s) => s.getVelocity(editor, { projectId: PROJECT })],
    [
      'team capacity',
      (s) => s.getTeamCapacity(editor, { projectId: PROJECT, iterationId: 'it-1' }),
    ],
    [
      'release tracking',
      (s) => s.getReleaseTracking(editor, { projectId: PROJECT, releaseId: release.id }),
    ],
    [
      'release burnup',
      (s) => s.getReleaseBurnup(editor, { projectId: PROJECT, releaseId: release.id }),
    ],
  ];

  for (const [name, call] of cases) {
    it(`${name} resolves the reader's ceiling`, async () => {
      const { service, access, scopes } = harness({ teams: [MINE_A] });
      await call(service);
      expect(access.resolveTeamScope).toHaveBeenCalledWith(WS, editor.sub, PROJECT);
      for (const scope of scopesOf(scopes))
        expect(scope).toEqual({ kind: 'teams', teamIds: [MINE_A] });
    });
  }
});

describe('frozen history: one series per read, never a sum and never a leak', () => {
  /**
   * The decision `frozenSeriesScope` records, seen from the outside.
   *
   * A multi-Team restricted reader asked for an aggregate that was never measured — the
   * `team_id IS NULL` row spans Teams they may not see, and summing the team rows is forbidden — so
   * the repository is still asked in their own scope (it is what refuses) and the chart reports the
   * history as unavailable instead of inventing or disclosing one.
   */
  it('serves an admin the MEASURED All Teams row, exactly as before', async () => {
    const { service } = harness({ teams: null });
    const report = await service.getIterationBurndown(admin, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });
    expect(report.points.map((p) => p.remainingToDo).filter((v) => v !== null)).toEqual([100]);
  });

  it("serves a single-Team reader that Team's own row, not the All Teams row", async () => {
    const { service, scopes } = harness({ teams: [MINE_A] });
    const report = await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });
    expect(report.points.map((p) => p.remainingToDo).filter((v) => v !== null)).toEqual([40]);
    expect(scopesOf(scopes)).not.toContainEqual({ kind: 'all' });
  });

  it('serves a MULTI-Team reader nothing, and says the history is unavailable', async () => {
    const { service, scopes } = harness({ teams: [MINE_A, MINE_B] });
    const report = await service.getIterationBurndown(editor, {
      projectId: PROJECT,
      iterationId: 'it-1',
    });

    // Asked in their own scope — the repository is where the refusal lives, so the service cannot
    // accidentally widen it — and never as All Teams, which would have read the 100.
    const frozen = scopes.filter((s) => s.method === 'getIterationSnapshots');
    expect(frozen).toHaveLength(1);
    expect(frozen[0].scope).toEqual({ kind: 'teams', teamIds: [MINE_A, MINE_B] });

    // No leak (100), no sum (65), no interpolation — the series simply was never measured.
    expect(report.points.every((p) => p.remainingToDo === null && p.ideal === null)).toBe(true);
    expect(report.historyState).toBe('missing');
    expect(report.totalTaskEstimateAtStart).toBeNull();
    expect(report.status).toBe('unknown');
    // `hasScheduledWork` stays TRUE, which is what makes the screen read "work exists, this scope's
    // history is unavailable" rather than "this team has nothing scheduled".
    expect(report.hasScheduledWork).toBe(true);
  });
});
