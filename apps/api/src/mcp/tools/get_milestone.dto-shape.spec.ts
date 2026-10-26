import { describe, expect, it } from 'vitest';
import { MAX_LINKS, shapeMilestone } from './get_milestone';

/**
 * The REAL response shapes, from the producers (milestones.controller.ts):
 *  - GET /v1/milestones/:id -> toMilestoneDto (MilestoneResponseDto): milestoneKey NULLABLE,
 *    status from milestoneStatusEnum, target window YYYY-MM-DD nullable, progress computed.
 *  - the :id/artifacts, :id/releases and :id/projects junction routes each answer a BARE
 *    string[] of ids (not rows, not paged).
 */
const MILESTONE_BODY = {
  id: 'm1',
  workspaceId: 'ws1',
  projectId: 'p1',
  milestoneKey: 'MS-1',
  name: 'Beta',
  description: null,
  notes: null,
  status: 'in_progress',
  ownerId: null,
  targetStartDate: '2026-10-01',
  targetEndDate: '2026-11-01',
  releaseIds: ['r1'],
  projectIds: ['p1'],
  teamIds: [],
  progress: 40,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

describe('shapeMilestone (MilestoneResponseDto + junction feeds -> tool payload)', () => {
  it('maps the milestone row and attaches the three id feeds', () => {
    const out = shapeMilestone(MILESTONE_BODY, ['w1', 'w2'], ['r1'], ['p1']);
    expect(out).toMatchObject({
      id: 'm1',
      milestoneKey: 'MS-1',
      name: 'Beta',
      status: 'in_progress',
      ownerId: null,
      targetStartDate: '2026-10-01',
      targetEndDate: '2026-11-01',
      progress: 40,
    });
    expect(out.artifacts).toEqual(['w1', 'w2']);
    expect(out.releases).toEqual(['r1']);
    expect(out.projects).toEqual(['p1']);
    expect(out['truncated']).toBeUndefined();
  });

  it('a nullable milestoneKey stays null, never undefined', () => {
    const out = shapeMilestone({ ...MILESTONE_BODY, milestoneKey: null }, [], [], []);
    expect(out).toHaveProperty('milestoneKey', null);
  });

  it('a feed at the cap flags truncated', () => {
    const full = Array.from({ length: MAX_LINKS }, (_, i) => `w${i}`);
    expect(shapeMilestone(MILESTONE_BODY, full, [], [])).toHaveProperty('truncated', true);
    expect((shapeMilestone(MILESTONE_BODY, full, [], [])['artifacts'] as string[]).length).toBe(
      MAX_LINKS,
    );
  });
});
