import { describe, expect, it } from 'vitest';
import { TeamWithStatsResponseSchema } from '@modules/workspace/interface/http/dto/team-response.dto';
import { MAX_TEAMS, shapeTeam, shapeTeams } from './list_teams';
import type { RefResolver } from './refs';

/** The picker feed the lead comes from; these tests only care about the row mapping. */
const NO_PEOPLE = { person: async () => null } as unknown as RefResolver;

const LEAD = '0194a000-0000-7000-8000-0000000000f1';
const PROJECT = '0194a000-0000-7000-8000-0000000000f2';

/**
 * The REAL response shape, from the producer (workspace/team.controller.ts
 * GET /workspaces/:workspaceId/teams -> toTeamWithStatsDto): a BARE array of
 * toTeamDto + memberCount + projects — no pageInfo; the tool caps the feed itself.
 * The fixture parses through the producer's schema, so a renamed producer field breaks this
 * test instead of silently reaching an agent.
 */
const TEAM_ROW = TeamWithStatsResponseSchema.parse({
  id: '0194a000-0000-7000-8000-0000000000f0',
  workspaceId: '0194a000-0000-7000-8000-0000000000f3',
  name: 'Alpha',
  key: 'ALP',
  description: 'Platform team',
  leadId: LEAD,
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  memberCount: 4,
  projects: [{ projectId: PROJECT, key: 'PAY', name: 'Payments' }],
});

describe('shapeTeam (toTeamWithStatsDto -> tool payload)', () => {
  it('maps each row keeping the route field names and the resolved lead', () => {
    const out = shapeTeam(TEAM_ROW, { id: LEAD, name: 'Ada Lovelace' });
    expect(out).toEqual({
      id: TEAM_ROW.id,
      name: 'Alpha',
      key: 'ALP',
      description: 'Platform team',
      status: 'active',
      lead: { id: LEAD, name: 'Ada Lovelace' },
      memberCount: 4,
      projects: TEAM_ROW.projects,
    });
    // the raw id is not relayed beside its resolved ref
    expect(out).not.toHaveProperty('leadId');
  });

  it('a team with no resolvable lead carries null, never a bare id', () => {
    expect(shapeTeam({ ...TEAM_ROW, leadId: null })).toMatchObject({ lead: null });
  });

  it('a nullable description stays null', () => {
    expect(shapeTeam({ ...TEAM_ROW, description: null })).toMatchObject({ description: null });
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
