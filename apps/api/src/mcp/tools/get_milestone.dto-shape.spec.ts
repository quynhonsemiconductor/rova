import { describe, expect, it } from 'vitest';
import { MilestoneResponseSchema } from '@modules/milestones/interface/http/dto/milestone-response.dto';
import { MAX_LINKS, resolveMilestoneRefs, shapeMilestone } from './get_milestone';
import type { RefResolver } from './refs';

/**
 * `rova_get_milestone` composes the MilestoneResponseDto (GET /v1/milestones/:id —
 * milestoneKey NULLABLE, target window YYYY-MM-DD nullable, progress computed) with the three
 * junction feeds (:id/artifacts, :id/releases, :id/projects — each a BARE id array). The
 * fixture parses through the REAL MilestoneResponseSchema.
 */
const MILESTONE_BODY = MilestoneResponseSchema.parse({
  id: '0194a000-0000-7000-8000-000000000001',
  workspaceId: '0194a000-0000-7000-8000-000000000002',
  projectId: '0194a000-0000-7000-8000-000000000003',
  milestoneKey: 'MS-1',
  name: 'Beta',
  description: null,
  notes: null,
  status: 'planned',
  ownerId: null,
  targetStartDate: '2026-06-01',
  targetEndDate: '2026-06-30',
  releaseIds: ['0194a000-0000-7000-8000-000000000004'],
  projectIds: ['0194a000-0000-7000-8000-000000000003'],
  teamIds: [],
  progress: {
    totalItems: 5,
    completedItems: 2,
    totalPoints: 20,
    completedPoints: 8,
    progressPercent: 40,
  },
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
});

const RELEASE_REF = {
  id: '0194a000-0000-7000-8000-000000000004',
  name: 'Autumn',
  key: 'RL-7',
};

const REFS = { owner: null, releases: [RELEASE_REF] };

describe('shapeMilestone (MilestoneResponseDto + junction feeds -> tool payload)', () => {
  it('maps the milestone row and attaches the three feeds, owner and releases by name', () => {
    const out = shapeMilestone(
      MILESTONE_BODY,
      ['0194a000-0000-7000-8000-000000000005'],
      ['0194a000-0000-7000-8000-000000000004'],
      ['0194a000-0000-7000-8000-000000000003'],
      REFS,
    );
    expect(out).toMatchObject({
      id: MILESTONE_BODY.id,
      milestoneKey: 'MS-1',
      name: 'Beta',
      status: 'planned',
      owner: null,
      targetStartDate: '2026-06-01',
      targetEndDate: '2026-06-30',
      progress: {
        totalItems: 5,
        completedItems: 2,
        totalPoints: 20,
        completedPoints: 8,
        progressPercent: 40,
      },
    });
    expect(out.artifacts).toEqual(['0194a000-0000-7000-8000-000000000005']);
    expect(out.releases).toEqual([RELEASE_REF]);
    expect(out.projects).toEqual(['0194a000-0000-7000-8000-000000000003']);
    expect(out['truncated']).toBeUndefined();
    // the raw ids are not relayed beside their resolved refs
    expect(out).not.toHaveProperty('ownerId');
  });

  it('a nullable milestoneKey stays null, never undefined', () => {
    const out = shapeMilestone({ ...MILESTONE_BODY, milestoneKey: null }, [], [], []);
    expect(out).toHaveProperty('milestoneKey', null);
  });

  it('truncated comes from the RAW feed length, before the cap slices it', () => {
    const raw = Array.from({ length: MAX_LINKS + 1 }, (_, i) => `w${i}`);
    const out = shapeMilestone(MILESTONE_BODY, raw, [], []);
    expect(out).toHaveProperty('truncated', true);
    expect((out['artifacts'] as string[]).length).toBe(MAX_LINKS);
    // exactly AT the cap is not truncated — the route returned everything there was
    const exact = Array.from({ length: MAX_LINKS }, (_, i) => `w${i}`);
    expect(shapeMilestone(MILESTONE_BODY, exact, [], [])['truncated']).toBeUndefined();
  });

  it('resolves the owner and each linked release through the reference feeds', async () => {
    const resolver = {
      person: async (id: string) => ({ id, name: 'Ada Lovelace' }),
      release: async (id: string) => ({ id, name: 'Autumn', key: 'RL-7' }),
    } as unknown as RefResolver;
    await expect(
      resolveMilestoneRefs(
        { ...MILESTONE_BODY, ownerId: 'u1' },
        ['0194a000-0000-7000-8000-000000000004'],
        resolver,
      ),
    ).resolves.toEqual({
      owner: { id: 'u1', name: 'Ada Lovelace' },
      releases: [RELEASE_REF],
    });
  });
});
