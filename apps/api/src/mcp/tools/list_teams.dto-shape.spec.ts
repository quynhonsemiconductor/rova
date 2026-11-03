import { describe, expect, it } from 'vitest';
import { MAX_TEAMS, shapeTeam, shapeTeams } from './list_teams';
import type { RefResolver } from './refs';

/** The picker feed the lead comes from; these tests only care about the row mapping. */
const NO_PEOPLE = { person: async () => null } as unknown as RefResolver;

/**
 * The REAL response shape, from the producer (workspace/team.controller.ts
 * GET /workspaces/:workspaceId/teams -> toTeamWithStatsDto): a BARE array of
 * toTeamDto + memberCount + projects — no pageInfo; the tool caps the feed itself.
 * There is NO zod schema for this route (the controller maps plain objects), so unlike the
 * other dto-shape specs this fixture is pinned BY HAND — a mapper change on the producer
 * must be mirrored here by review, not by parse().
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

describe('shapeTeam (toTeamWithStatsDto -> tool payload)', () => {
  it('maps each row keeping the route field names and the resolved lead', () => {
    const out = shapeTeam(TEAM_ROW, { id: 'u1', name: 'Ada Lovelace' });
    expect(out).toEqual({
      id: 't1',
      name: 'Alpha',
      key: 'ALP',
      description: 'Platform team',
      status: 'active',
      lead: { id: 'u1', name: 'Ada Lovelace' },
      memberCount: 4,
      projects: TEAM_ROW.projects,
    });
    // the raw id is not relayed beside its resolved ref
    expect(out).not.toHaveProperty('leadId');
  });

  it('a team with no resolvable lead carries null, never a bare id', () => {
    expect(shapeTeam({ ...TEAM_ROW, leadId: null })).toMatchObject({ lead: null });
  });

  it('a nullable key/description stays null', () => {
    const bare = { ...TEAM_ROW, key: null, description: null };
    expect(shapeTeam(bare)).toMatchObject({ key: null, description: null });
  });

  it('the cap is an agent-sized page', () => {
    expect(MAX_TEAMS).toBe(100);
  });

  it('past the cap rows are cut and truncated is set', async () => {
    const many = Array.from({ length: MAX_TEAMS + 1 }, () => TEAM_ROW);
    const out = await shapeTeams(many, NO_PEOPLE);
    expect((out['teams'] as unknown[]).length).toBe(MAX_TEAMS);
    expect(out).toHaveProperty('truncated', true);

    const exact = await shapeTeams([TEAM_ROW], NO_PEOPLE);
    expect(exact).not.toHaveProperty('truncated');
  });
});
