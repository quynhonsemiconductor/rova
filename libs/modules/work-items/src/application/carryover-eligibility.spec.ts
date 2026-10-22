/**
 * Carryover eligibility — ONE PREDICATE PER TEST (plan D5, the Split §7 convention).
 */
import { describe, expect, it } from 'vitest';

import {
  containsDate,
  eligibleIterations,
  isAfterCurrent,
  isCurrentOrLater,
  isEligibleIteration,
  isEnabledDate,
  isOpenState,
  isSameProject,
  isSameTeam,
  minDate,
  resolveTargets,
  targetEndVerdict,
  type CarryoverIteration,
} from './carryover-eligibility';

const PROJECT = 'p1';
const ALPHA = 'team-alpha';
const BETA = 'team-beta';

function it_(overrides: Partial<CarryoverIteration> & { id: string }): CarryoverIteration {
  return {
    name: overrides.id,
    iterationKey: null,
    state: 'committed',
    startDate: '2026-06-01',
    endDate: '2026-06-14',
    projectId: PROJECT,
    teamId: ALPHA,
    ...overrides,
  };
}

const A = it_({ id: 'A', startDate: '2026-06-01', endDate: '2026-06-14' });
const B = it_({ id: 'B', state: 'planning', startDate: '2026-06-15', endDate: '2026-06-28' });
const C = it_({ id: 'C', state: 'planning', startDate: '2026-06-29', endDate: '2026-07-12' });
const STORY = { projectId: PROJECT, teamId: ALPHA, startDate: null as string | null };

describe('isSameTeam (R7 strict equality)', () => {
  it('admits team/team equality', () => {
    expect(isSameTeam({ teamId: ALPHA }, { teamId: ALPHA })).toBe(true);
  });
  it('refuses different teams', () => {
    expect(isSameTeam({ teamId: ALPHA }, { teamId: BETA })).toBe(false);
  });
  it('admits null/null', () => {
    expect(isSameTeam({ teamId: null }, { teamId: null })).toBe(true);
  });
  it('refuses a team-owned Story into a team-less (shared) Iteration — unlike Split', () => {
    expect(isSameTeam({ teamId: ALPHA }, { teamId: null })).toBe(false);
  });
  it('refuses a team-less Story into a team Iteration', () => {
    expect(isSameTeam({ teamId: null }, { teamId: ALPHA })).toBe(false);
  });
});

describe('isSameProject', () => {
  it('refuses another project', () => {
    expect(isSameProject({ projectId: PROJECT }, { projectId: 'other' })).toBe(false);
  });
  it('admits the same project', () => {
    expect(isSameProject({ projectId: PROJECT }, { projectId: PROJECT })).toBe(true);
  });
});

describe('isOpenState', () => {
  it.each([
    ['planning', true],
    ['committed', true],
    ['accepted', false],
  ] as const)('%s → %s', (state, expected) => {
    expect(isOpenState({ state })).toBe(expected);
  });
});

describe('isCurrentOrLater (R9)', () => {
  it('admits the current Iteration itself', () => {
    expect(isCurrentOrLater(A, A)).toBe(true);
  });
  it('admits one starting after the current starts, even when it overlaps', () => {
    const overlap = it_({ id: 'O', startDate: '2026-06-10', endDate: '2026-06-24' });
    expect(isCurrentOrLater(overlap, A)).toBe(true);
  });
  it('refuses one starting on the same day', () => {
    expect(isCurrentOrLater(it_({ id: 'S', startDate: A.startDate }), A)).toBe(false);
  });
  it('refuses an earlier one', () => {
    expect(isCurrentOrLater(A, B)).toBe(false);
  });
  it('refuses a dateless candidate', () => {
    expect(isCurrentOrLater(it_({ id: 'D', startDate: null, endDate: null }), A)).toBe(false);
  });
});

describe('isEligibleIteration', () => {
  it('admits a later open same-team sprint', () => {
    expect(isEligibleIteration(STORY, B, A)).toBe(true);
  });
  it('refuses an accepted current Iteration', () => {
    const accepted = { ...A, state: 'accepted' as const };
    expect(isEligibleIteration(STORY, accepted, accepted)).toBe(false);
  });
});

describe('eligibleIterations', () => {
  it('sorts by start date then name', () => {
    const b2 = it_({ id: 'B2', name: 'Aardvark', startDate: B.startDate, endDate: B.endDate });
    expect(eligibleIterations(STORY, [C, B, A, b2], A).map((i) => i.id)).toEqual([
      'A',
      'B2',
      'B',
      'C',
    ]);
  });
});

describe('minDate (CO-BR-13/14)', () => {
  it('is the Story Start Date when set', () => {
    expect(minDate({ startDate: '2026-06-05' }, [A, B])).toBe('2026-06-05');
  });
  it('is the earliest eligible start without a Start Date', () => {
    expect(minDate({ startDate: null }, [A, B])).toBe('2026-06-01');
  });
  it('is null with nothing eligible', () => {
    expect(minDate({ startDate: '2026-06-05' }, [])).toBeNull();
  });
  it('skips a dateless entry sorted first instead of disabling the whole calendar', () => {
    const dateless = it_({ id: 'D', state: 'planning', startDate: null, endDate: null });
    expect(minDate({ startDate: null }, [dateless, B])).toBe('2026-06-15');
    expect(minDate({ startDate: null }, [dateless])).toBeNull();
  });
});

describe('isEnabledDate (CO-BR-15/16)', () => {
  it('refuses a date before the Start Date', () => {
    expect(isEnabledDate('2026-06-04', { startDate: '2026-06-05' }, A, [A, B])).toBe(false);
  });
  it('admits a date inside the current Iteration', () => {
    expect(isEnabledDate('2026-06-10', { startDate: null }, A, [A, B])).toBe(true);
  });
  it('admits a date inside a future eligible Iteration', () => {
    expect(isEnabledDate('2026-06-20', { startDate: null }, A, [A, B])).toBe(true);
  });
  it('refuses a date outside every eligible Iteration', () => {
    expect(isEnabledDate('2026-08-01', { startDate: null }, A, [A, B])).toBe(false);
  });
  it('R6 — with an accepted current Iteration, refuses its own window', () => {
    const accepted = { ...A, state: 'accepted' as const };
    const overlap = it_({ id: 'O', startDate: '2026-06-10', endDate: '2026-06-24' });
    expect(isEnabledDate('2026-06-12', { startDate: null }, accepted, [overlap])).toBe(false);
  });
  it('R6 — with an accepted current Iteration, admits a future date', () => {
    const accepted = { ...A, state: 'accepted' as const };
    expect(isEnabledDate('2026-06-20', { startDate: null }, accepted, [B])).toBe(true);
  });
});

describe('resolveTargets (CO-BR-18..20)', () => {
  it('is empty for a date inside the current Iteration', () => {
    expect(resolveTargets('2026-06-10', A, [A, B])).toEqual([]);
  });
  it('proposes the one Iteration containing a later date', () => {
    expect(resolveTargets('2026-06-20', A, [A, B, C]).map((i) => i.id)).toEqual(['B']);
  });
  it('returns every overlapping Iteration containing the date', () => {
    const overlap = it_({ id: 'O', startDate: '2026-06-18', endDate: '2026-07-01' });
    expect(resolveTargets('2026-06-20', A, [A, B, overlap]).map((i) => i.id)).toEqual(['B', 'O']);
  });
  it('is empty when nothing contains the date', () => {
    expect(resolveTargets('2026-09-01', A, [A, B])).toEqual([]);
  });
});

describe('isAfterCurrent / containsDate', () => {
  it('is false on the last day of the current Iteration', () => {
    expect(isAfterCurrent('2026-06-14', A)).toBe(false);
  });
  it('containsDate is inclusive at both ends', () => {
    expect(containsDate(A, '2026-06-01') && containsDate(A, '2026-06-14')).toBe(true);
  });
});

describe('targetEndVerdict (D7)', () => {
  it('saves a date inside the current Iteration', () => {
    expect(targetEndVerdict('2026-06-10', { startDate: null }, A, [A, B])).toBe('save');
  });
  it('requires a Carryover for a later date', () => {
    expect(targetEndVerdict('2026-06-20', { startDate: null }, A, [A, B])).toBe(
      'requires_carryover',
    );
  });
  it('refuses a disabled date', () => {
    expect(targetEndVerdict('2026-05-01', { startDate: null }, A, [A, B])).toBe('invalid');
  });
});
