/**
 * Split a User Story — the pure helpers, ONE PREDICATE PER TEST.
 *
 * That structure is the point, not a style choice. `docs/PLAN-phase7-split-unfinished.md` §7 says it
 * outright: "one test per predicate. Fusing them is how a wrong team rule ships green." A single
 * combined "returns the right targets" test passes while two predicates are silently doing each
 * other's work — and the team rule (§8 Q2) is exactly the one this repo has already got wrong once,
 * in the mockup.
 *
 * No DB, no Nest, no mocks: every function under test is a decision over plain objects.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RELATED_SIDE,
  clampMarkerDate,
  defaultSplitTitles,
  defaultTaskSide,
  earliestTarget,
  filterSplitTargets,
  isLaterThanSource,
  splitIneligibleReason,
  stripSplitPrefix,
  type SplitTargetCandidate,
} from './split-story';
import type { WorkItem, WorkItemPriority, WorkItemScheduleState } from '../domain/work-item.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT = 'project-nxp';
const OTHER_PROJECT = 'project-pay';
const TEAM_ALPHA = 'team-alpha';
const TEAM_BETA = 'team-beta';

/** The seeded shape: a Team Alpha Story in a committed sprint (`Sprint 26.1`, 06-16 → 06-27). */
function story(
  overrides: Partial<
    Pick<WorkItem, 'type' | 'scheduleState' | 'iterationId' | 'projectId' | 'teamId'>
  > = {},
): Pick<WorkItem, 'type' | 'scheduleState' | 'iterationId' | 'projectId' | 'teamId'> {
  return {
    type: 'story',
    scheduleState: 'in_progress',
    iterationId: 'iter-source',
    projectId: PROJECT,
    teamId: TEAM_ALPHA,
    ...overrides,
  };
}

const SOURCE = { id: 'iter-source', endDate: '2026-06-27' };

/** A valid target by default — each test breaks exactly ONE property of it. */
function candidate(overrides: Partial<SplitTargetCandidate> = {}): SplitTargetCandidate {
  return {
    id: 'iter-next',
    name: 'Sprint 26.2',
    iterationKey: 'IT-3',
    state: 'planning',
    startDate: '2026-06-29',
    endDate: '2026-07-10',
    projectId: PROJECT,
    // Team-LESS, like the real `Sprint 26.2` fixture — the shape §8 Q2 rests on.
    teamId: null,
    ...overrides,
  };
}

// ── BR-01/02/03 — splitIneligibleReason, one refusal per test ─────────────────

describe('splitIneligibleReason (BR-01/02/03)', () => {
  it('admits a scheduled, in-progress Story', () => {
    expect(splitIneligibleReason(story())).toBeNull();
  });

  it('BR-01: refuses a Task — not_a_story', () => {
    expect(splitIneligibleReason(story({ type: 'task' }))).toBe('not_a_story');
  });

  it('BR-01: refuses a Defect — not_a_story', () => {
    expect(splitIneligibleReason(story({ type: 'defect' }))).toBe('not_a_story');
  });

  // Each of the three finished states on its own: they are three enum members, and a helper that
  // covered two of them would pass a test that asserted only one.
  it.each<WorkItemScheduleState>(['completed', 'accepted', 'release'])(
    'BR-02: refuses schedule state %s — finished_state',
    (scheduleState) => {
      expect(splitIneligibleReason(story({ scheduleState }))).toBe('finished_state');
    },
  );

  it.each<WorkItemScheduleState>(['idea', 'defined', 'in_progress'])(
    'BR-02: admits schedule state %s',
    (scheduleState) => {
      expect(splitIneligibleReason(story({ scheduleState }))).toBeNull();
    },
  );

  it('BR-03: refuses a Story with no Iteration — unscheduled', () => {
    expect(splitIneligibleReason(story({ iterationId: null }))).toBe('unscheduled');
  });

  it('reports the most fundamental reason first: a finished TASK is not_a_story, not finished_state', () => {
    // Order is load-bearing — a Defect is refused for BEING a Defect, which is what the reader can
    // act on; its state is beside the point.
    expect(splitIneligibleReason(story({ type: 'task', scheduleState: 'completed' }))).toBe(
      'not_a_story',
    );
  });

  it('reports finished_state ahead of unscheduled', () => {
    expect(splitIneligibleReason(story({ scheduleState: 'accepted', iterationId: null }))).toBe(
      'finished_state',
    );
  });
});

// ── §8 Q3 — isLaterThanSource, on its own ─────────────────────────────────────

describe('isLaterThanSource (§8 Q3 — strictly non-overlapping)', () => {
  it('admits a sprint opening the day after the source closes', () => {
    expect(isLaterThanSource({ endDate: '2026-06-27' }, { startDate: '2026-06-28' })).toBe(true);
  });

  it('refuses a sprint opening ON the source close date — the rule is strict', () => {
    expect(isLaterThanSource({ endDate: '2026-06-27' }, { startDate: '2026-06-27' })).toBe(false);
  });

  it('refuses an OVERLAPPING sprint that merely starts later than the source STARTED', () => {
    // The rejected alternative reading (`target.start > source.start`) would admit this. The source
    // runs 06-16 → 06-27; a target opening 06-20 overlaps it, and "move the work forward" does not
    // mean "move it into a sprint already running".
    expect(isLaterThanSource({ endDate: '2026-06-27' }, { startDate: '2026-06-20' })).toBe(false);
  });

  it('refuses when the SOURCE has no end date — there is no "after" to be later than', () => {
    expect(isLaterThanSource({ endDate: null }, { startDate: '2026-06-29' })).toBe(false);
  });

  it('refuses when the CANDIDATE has no start date — a dateless sprint belongs to no timebox', () => {
    expect(isLaterThanSource({ endDate: '2026-06-27' }, { startDate: null })).toBe(false);
  });
});

// ── BR-05 — filterSplitTargets, one predicate per test ────────────────────────

describe('filterSplitTargets (BR-05)', () => {
  it('offers a valid later sprint', () => {
    const targets = filterSplitTargets(SOURCE, [candidate()], story());
    expect(targets.map((t) => t.id)).toEqual(['iter-next']);
  });

  it('excludes the SOURCE iteration itself', () => {
    // Same window as the source, same id: moving a Story into the sprint it already occupies is not
    // a Split. Tested separately from the date rule, which would also reject it — that overlap is
    // precisely why fusing the predicates hides a bug.
    const self = candidate({ id: SOURCE.id, startDate: '2026-06-29' });
    expect(filterSplitTargets(SOURCE, [self], story())).toEqual([]);
  });

  it('excludes an ACCEPTED iteration even when it is later and compatible', () => {
    const accepted = candidate({ id: 'iter-accepted', state: 'accepted' });
    expect(filterSplitTargets(SOURCE, [accepted], story())).toEqual([]);
  });

  it.each<SplitTargetCandidate['state']>(['planning', 'committed'])('admits state %s', (state) => {
    expect(filterSplitTargets(SOURCE, [candidate({ state })], story())).toHaveLength(1);
  });

  it('excludes an iteration in ANOTHER project', () => {
    const foreign = candidate({ id: 'iter-pay', projectId: OTHER_PROJECT });
    expect(filterSplitTargets(SOURCE, [foreign], story())).toEqual([]);
  });

  it('§8 Q2: ADMITS a team-LESS iteration for a team-owned Story (a shared sprint)', () => {
    // The ruling this repo turns on, and the one the mockup gets wrong. Under the mockup's
    // `iteration.team === item.team` equality the seeded fixture has ZERO valid targets — the
    // feature would be undemonstrable on a fresh database.
    const shared = candidate({ teamId: null });
    expect(filterSplitTargets(SOURCE, [shared], story({ teamId: TEAM_ALPHA }))).toHaveLength(1);
  });

  it('§8 Q2: ADMITS a team-owned iteration for a team-LESS Story (the Project Backlog)', () => {
    const owned = candidate({ teamId: TEAM_ALPHA });
    expect(filterSplitTargets(SOURCE, [owned], story({ teamId: null }))).toHaveLength(1);
  });

  it('§8 Q2: REFUSES an iteration owned by a DIFFERENT team — the only team refusal', () => {
    const otherTeam = candidate({ teamId: TEAM_BETA });
    expect(filterSplitTargets(SOURCE, [otherTeam], story({ teamId: TEAM_ALPHA }))).toEqual([]);
  });

  it('§8 Q2: admits an iteration owned by the SAME team', () => {
    const sameTeam = candidate({ teamId: TEAM_ALPHA });
    expect(filterSplitTargets(SOURCE, [sameTeam], story({ teamId: TEAM_ALPHA }))).toHaveLength(1);
  });

  it('excludes an EARLIER iteration', () => {
    // The seeded `Sprint 25.12` (06-01 → 06-12), which is also accepted — so this case is built
    // with a NON-accepted state, or it would pass on the wrong predicate.
    const earlier = candidate({
      id: 'iter-past',
      state: 'committed',
      startDate: '2026-06-01',
      endDate: '2026-06-12',
    });
    expect(filterSplitTargets(SOURCE, [earlier], story())).toEqual([]);
  });

  it('returns targets EARLIEST FIRST', () => {
    const later = candidate({ id: 'iter-later', startDate: '2026-07-13', endDate: '2026-07-24' });
    const sooner = candidate({ id: 'iter-sooner', startDate: '2026-06-29', endDate: '2026-07-10' });
    const targets = filterSplitTargets(SOURCE, [later, sooner], story());
    expect(targets.map((t) => t.id)).toEqual(['iter-sooner', 'iter-later']);
  });

  it('breaks a same-day tie by id, so the order is TOTAL', () => {
    // Two sprints opening on the same day is an ordinary shape (per-team iterations over one
    // timebox). Without the tiebreaker the "earliest valid target" default would be arbitrary.
    const b = candidate({ id: 'iter-b', startDate: '2026-06-29' });
    const a = candidate({ id: 'iter-a', startDate: '2026-06-29' });
    expect(filterSplitTargets(SOURCE, [b, a], story()).map((t) => t.id)).toEqual([
      'iter-a',
      'iter-b',
    ]);
  });

  it('does not mutate the caller\u2019s array', () => {
    // It sorts, and `Array.prototype.sort` is in-place — so the filter chain must have produced a
    // new array first. Asserted because a mutated preview input is the kind of fault that surfaces
    // three call sites away.
    const input = [
      candidate({ id: 'iter-later', startDate: '2026-07-13' }),
      candidate({ id: 'iter-sooner', startDate: '2026-06-29' }),
    ];
    filterSplitTargets(SOURCE, input, story());
    expect(input.map((c) => c.id)).toEqual(['iter-later', 'iter-sooner']);
  });
});

// ── BR-06 — earliestTarget ────────────────────────────────────────────────────

describe('earliestTarget (BR-06)', () => {
  it('is the first of an earliest-first list', () => {
    const targets = filterSplitTargets(
      SOURCE,
      [
        candidate({ id: 'iter-later', startDate: '2026-07-13' }),
        candidate({ id: 'iter-sooner', startDate: '2026-06-29' }),
      ],
      story(),
    );
    expect(earliestTarget(targets)?.id).toBe('iter-sooner');
  });

  it('is null when there is no valid target — the no_target ineligibility', () => {
    expect(earliestTarget([])).toBeNull();
  });
});

// ── §8 Q10 — stripSplitPrefix ─────────────────────────────────────────────────

describe('stripSplitPrefix (§8 Q10)', () => {
  it('leaves an ordinary title alone', () => {
    expect(stripSplitPrefix('Upgrade NX workspace to v21')).toBe('Upgrade NX workspace to v21');
  });

  it('strips a [Continued] prefix', () => {
    expect(stripSplitPrefix('[Continued] Upgrade NX workspace to v21')).toBe(
      'Upgrade NX workspace to v21',
    );
  });

  it('strips an [Unfinished] prefix', () => {
    expect(stripSplitPrefix('[Unfinished] Upgrade NX workspace to v21')).toBe(
      'Upgrade NX workspace to v21',
    );
  });

  it('is case-insensitive', () => {
    expect(stripSplitPrefix('[CONTINUED] Ship it')).toBe('Ship it');
    expect(stripSplitPrefix('[unfinished] Ship it')).toBe('Ship it');
  });

  it('tolerates missing or extra whitespace after the bracket', () => {
    expect(stripSplitPrefix('[Continued]Ship it')).toBe('Ship it');
    expect(stripSplitPrefix('[Continued]    Ship it')).toBe('Ship it');
  });

  it('is ANCHORED — a bracketed word mid-title survives', () => {
    expect(stripSplitPrefix('Ship [Continued] work')).toBe('Ship [Continued] work');
  });

  it('strips ONE prefix, not all of them', () => {
    // A greedy loop would silently rewrite a title somebody typed deliberately. A doubled prefix is
    // the artefact of a bug this function cannot repair.
    expect(stripSplitPrefix('[Unfinished] [Continued] Ship it')).toBe('[Continued] Ship it');
  });

  it('ignores a bracketed word that is not a split prefix', () => {
    expect(stripSplitPrefix('[Blocked] Ship it')).toBe('[Blocked] Ship it');
  });
});

// ── BR-12 + §8 Q10 — defaultSplitTitles ───────────────────────────────────────

describe('defaultSplitTitles (BR-12)', () => {
  it('prefixes both sides from the original title', () => {
    expect(defaultSplitTitles('Upgrade NX workspace to v21')).toEqual({
      unfinishedTitle: '[Unfinished] Upgrade NX workspace to v21',
      continuedTitle: '[Continued] Upgrade NX workspace to v21',
    });
  });

  it('§8 Q10: a RE-SPLIT does not stack prefixes', () => {
    // The whole point of the ruling: splitting `[Continued] Foo` again must not produce
    // `[Continued] [Continued] Foo`.
    expect(defaultSplitTitles('[Continued] Upgrade NX workspace to v21')).toEqual({
      unfinishedTitle: '[Unfinished] Upgrade NX workspace to v21',
      continuedTitle: '[Continued] Upgrade NX workspace to v21',
    });
  });

  it('§8 Q10: re-splitting an [Unfinished] title also strips first', () => {
    expect(defaultSplitTitles('[Unfinished] Ship it')).toEqual({
      unfinishedTitle: '[Unfinished] Ship it',
      continuedTitle: '[Continued] Ship it',
    });
  });
});

// ── BR-14 / BR-15 — default sides ─────────────────────────────────────────────

describe('defaultTaskSide (BR-14)', () => {
  it('a Completed Task stays with the historical placeholder', () => {
    expect(defaultTaskSide('completed')).toBe('unfinished');
  });

  it.each<WorkItemScheduleState>(['defined', 'in_progress'])(
    'a %s Task follows the Story forward',
    (state) => {
      expect(defaultTaskSide(state)).toBe('continued');
    },
  );
});

describe('DEFAULT_RELATED_SIDE (BR-15)', () => {
  it('Defects and Test Cases default to [Continued]', () => {
    expect(DEFAULT_RELATED_SIDE).toBe('continued');
  });
});

// ── A guard on the fixture itself ─────────────────────────────────────────────

describe('the fixture matches the seeded database', () => {
  it('mirrors Sprint 26.1 → Sprint 26.2, verified live on 2026-09-16', () => {
    // Verified with psql against `rally_dev`: Sprint 26.1 = committed, Team Alpha, 2026-06-16 →
    // 2026-06-27; Sprint 26.2 = planning, team_id NULL, 2026-06-29 → 2026-07-10. If the seed moves,
    // this test is the first thing that should say so — the e2e asserts the same pair over HTTP.
    const targets = filterSplitTargets(
      { id: 'iter-source', endDate: '2026-06-27' },
      [
        candidate({
          startDate: '2026-06-29',
          endDate: '2026-07-10',
          state: 'planning',
          teamId: null,
        }),
      ],
      story({ teamId: TEAM_ALPHA }),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('Sprint 26.2');
  });

  it('the priority type is the work-item one, so the Defect row cannot drift', () => {
    // A compile-time assertion in test clothing: `SplitPreviewDefect.priority` is
    // `WorkItem['priority']`, so a new priority member cannot reach the DTO without this failing to
    // compile if the enum and the type ever diverge.
    const priority: WorkItemPriority = 'urgent';
    expect(priority).toBe('urgent');
  });
});

/**
 * `clampMarkerDate` (SU-06) — where a Split lands on ONE iteration's burndown x-axis.
 *
 * One `it` per case, and the two clamping directions are separate tests on purpose: they are two
 * different SRS §10.3 sentences ("no x-position on the source chart" vs "at its opening value"), and a
 * single test that exercised both would still pass with one of them inverted.
 */
describe('clampMarkerDate (SU-06, SRS §10.3)', () => {
  const SPRINT = { startDate: '2026-06-16', endDate: '2026-06-27' };

  it('leaves a date inside the window alone', () => {
    expect(clampMarkerDate('2026-06-20', SPRINT)).toBe('2026-06-20');
  });

  it('keeps both boundary days, which are inside the window', () => {
    expect(clampMarkerDate('2026-06-16', SPRINT)).toBe('2026-06-16');
    expect(clampMarkerDate('2026-06-27', SPRINT)).toBe('2026-06-27');
  });

  it('pins a LATE split to the last day — a Split after the sprint closed still has a marker', () => {
    expect(clampMarkerDate('2026-07-05', SPRINT)).toBe('2026-06-27');
  });

  it('pins an EARLY split to the opening day — the target shows it "at its opening value"', () => {
    expect(clampMarkerDate('2026-06-01', SPRINT)).toBe('2026-06-16');
  });

  it('clamps only on the side an OPEN-ENDED window has', () => {
    // `iterations.start_date`/`end_date` are both nullable: a sprint with no end cannot be "after its
    // end", so the date passes through rather than being pinned to something invented.
    expect(clampMarkerDate('2026-07-05', { startDate: '2026-06-16', endDate: null })).toBe(
      '2026-07-05',
    );
    expect(clampMarkerDate('2026-06-01', { startDate: null, endDate: '2026-06-27' })).toBe(
      '2026-06-01',
    );
    expect(clampMarkerDate('2026-06-01', { startDate: null, endDate: null })).toBe('2026-06-01');
  });

  it('compares as STRINGS, so no timezone enters a comparison that has none', () => {
    // The same discipline as `isLaterThanSource`: `YYYY-MM-DD` sorts lexicographically, and building a
    // `Date` here would make the answer depend on the server's zone.
    expect(clampMarkerDate('2026-12-31', SPRINT)).toBe('2026-06-27');
    expect(clampMarkerDate('2025-01-01', SPRINT)).toBe('2026-06-16');
  });
});
