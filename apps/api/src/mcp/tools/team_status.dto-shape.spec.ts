import { describe, expect, it } from 'vitest';
import { shapeTeamStatus } from './team_status';

/** The real Team Status board body shape (team-status.types.ts TeamStatusResponse). */
const BOARD = {
  projectId: 'p1',
  teamId: null,
  iteration: { id: 'it1', name: 'Sprint 1', startDate: '2026-10-01', endDate: '2026-10-15' },
  totals: { capacityHours: 80, taskCount: 6, estimateHours: 40, todoHours: 20, actualHours: 12 },
  groups: [
    {
      owner: { id: 'u1', displayName: 'Member One', avatarUrl: null },
      capacityHours: 40,
      taskCount: 3,
      estimateHours: 20,
      todoHours: 10,
      actualHours: 6,
      progressPercent: 40,
      tasks: [],
    },
    {
      owner: { id: 'u2', displayName: 'Member Two', avatarUrl: null },
      capacityHours: 40,
      taskCount: 3,
      estimateHours: 20,
      todoHours: 10,
      actualHours: 6,
      progressPercent: 40,
      tasks: [],
    },
  ],
};

describe('shapeTeamStatus (TeamStatusResponse -> tool payload)', () => {
  it('reads the member name from owner.displayName and keeps the board fields', () => {
    const out = shapeTeamStatus(BOARD);
    expect(out.iteration).toEqual({
      name: 'Sprint 1',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });
    expect(out.totals).toEqual(BOARD.totals);
    const members = out.members as Record<string, unknown>[];
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m).toHaveProperty('displayName');
      expect(m).toHaveProperty('capacityHours');
      expect(m).toHaveProperty('progressPercent');
    }
  });

  it('caps the member groups at 100 and sets truncated', () => {
    const big = {
      ...BOARD,
      groups: Array.from({ length: 150 }, (_, i) => ({
        ...BOARD.groups[0],
        owner: { id: `u${i}`, displayName: `Member ${i}`, avatarUrl: null },
      })),
    };
    const out = shapeTeamStatus(big);
    expect((out.members as unknown[]).length).toBe(100);
    expect(out.truncated).toBe(true);
  });

  it('an empty board yields empty members and no truncated flag', () => {
    const out = shapeTeamStatus({ groups: [] });
    expect(out.members).toEqual([]);
    expect(out.truncated).toBeUndefined();
  });
});
