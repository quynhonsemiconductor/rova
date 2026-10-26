import { describe, expect, it } from 'vitest';
import { MAX_TEAMS, shapeTeam, shapeTeams } from './list_teams';

/**
 * The REAL response shape, from the producer (workspace/team.controller.ts
 * GET /workspaces/:workspaceId/teams -> toTeamWithStatsDto): a BARE array of
 * toTeamDto + memberCount + projects — no pageInfo; the tool caps the feed itself.
 */
const TEAM_ROW = {
  id: 't1',
  workspaceId: 'ws1',
  name: 'Alpha',
  key: 'ALP',
  description: 'Platform team',
  leadId: 'u1',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  memberCount: 4,
  projects: [{ id: 'p1', key: 'PAY', name: 'Payments' }],
};

describe('shapeTeams (toTeamWithStatsDto[] -> tool payload)', () => {
  it('maps each row keeping the route field names, under the `teams` list key', () => {
    const out = shapeTeams([TEAM_ROW]);
    expect(out.teams).toEqual([
      {
        id: 't1',
        name: 'Alpha',
        key: 'ALP',
        description: 'Platform team',
        status: 'active',
        leadId: 'u1',
        memberCount: 4,
        projects: TEAM_ROW.projects,
      },
    ]);
    expect(out['truncated']).toBeUndefined();
  });

  it('a nullable key/description stays null', () => {
    const bare = { ...TEAM_ROW, key: null, description: null };
    expect(shapeTeam(bare)).toMatchObject({ key: null, description: null });
  });

  it('past the cap rows are cut and truncated is set', () => {
    const many = Array.from({ length: MAX_TEAMS + 1 }, () => TEAM_ROW);
    const out = shapeTeams(many);
    expect((out['teams'] as unknown[]).length).toBe(MAX_TEAMS);
    expect(out).toHaveProperty('truncated', true);
  });
});
