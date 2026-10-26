import { describe, expect, it } from 'vitest';
import { TeamStatusResponseSchema } from '@modules/team-status/interface/http/dto/team-status-response.dto';
import { shapeTeamStatus } from './team_status';

/**
 * The REAL TeamStatusResponse shape (GET /v1/team-status), parsed through the producer's own
 * zod schema: `taskCount` lives on each MEMBER GROUP, not on `totals` — the invented fixture
 * that said otherwise is exactly what this parse() now prevents.
 */
const BOARD = TeamStatusResponseSchema.parse({
  projectId: '0194a000-0000-7000-8000-000000000001',
  teamId: '0194a000-0000-7000-8000-000000000002',
  iteration: {
    id: '0194a000-0000-7000-8000-000000000003',
    name: 'Sprint 1',
    startDate: '2026-10-01',
    endDate: '2026-10-15',
  },
  totals: { capacityHours: 80, estimateHours: 40, todoHours: 20, actualHours: 12 },
  groups: [
    {
      owner: {
        id: '0194a000-0000-7000-8000-000000000004',
        displayName: 'Member One',
        avatarUrl: null,
      },
      capacityHours: 40,
      taskCount: 3,
      estimateHours: 20,
      todoHours: 10,
      actualHours: 6,
      progressPercent: 40,
      tasks: [],
    },
    {
      owner: {
        id: '0194a000-0000-7000-8000-000000000005',
        displayName: 'Member Two',
        avatarUrl: null,
      },
      capacityHours: 40,
      taskCount: 3,
      estimateHours: 20,
      todoHours: 10,
      actualHours: 6,
      progressPercent: 40,
      tasks: [],
    },
  ],
});

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
      expect(m).toHaveProperty('taskCount');
    }
  });

  it('totals carry NO taskCount (that is a per-member number on the DTO)', () => {
    const out = shapeTeamStatus(BOARD);
    expect(out.totals).not.toHaveProperty('taskCount');
  });

  it('caps the member groups at 100 (the route returns one group per member)', () => {
    const big = {
      ...BOARD,
      groups: Array.from({ length: 101 }, (_, i) => ({
        ...BOARD.groups[0],
        owner: {
          ...BOARD.groups[0].owner,
          id: `0194a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        },
      })),
    };
    const out = shapeTeamStatus(big);
    expect((out.members as unknown[]).length).toBe(100);
    expect(out['truncated']).toBe(true);
  });
});
