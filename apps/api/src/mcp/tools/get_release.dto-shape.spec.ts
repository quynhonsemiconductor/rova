import { describe, expect, it } from 'vitest';
import { shapeRelease } from './get_release';

/**
 * The REAL response shapes, from the producers:
 *  - GET /v1/releases/:id -> toReleaseDto (releases.controller.ts): the release row with
 *    `taskEstimate` and the OPTIONAL `taskRollup` { estimateHours, toDoHours, actualHours,
 *    acceptedItems }. There is NO top-level estimateHours/acceptedItems and NO `rollup`.
 *  - GET /v1/releases/:id/artifacts -> PagedResult<ReleaseArtifactDto> = { data, pageInfo } —
 *    a PAGE, not a bare array (the shape that broke the first draft of this tool).
 */
const RELEASE_BODY = {
  id: 'r1',
  workspaceId: 'ws1',
  projectId: 'p1',
  releaseKey: 'REL-1',
  name: 'R1 2026',
  description: null,
  theme: null,
  status: 'active',
  startDate: '2026-10-01',
  releaseDate: null,
  plannedVelocity: 30,
  planEstimate: 40,
  taskEstimate: 120,
  taskRollup: { estimateHours: 120, toDoHours: 60, actualHours: 20, acceptedItems: 2 },
};

const ARTIFACT_ROW = {
  id: 'w1',
  itemKey: 'PAY-1',
  type: 'story',
  title: 'Login bug',
  scheduleState: 'started',
  priority: 'high',
  assigneeId: null,
  assigneeName: 'Member One',
  iterationId: null,
  releaseId: 'r1',
  storyPoints: 5,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

describe('shapeRelease (ReleaseResponseDto + artifacts page -> tool payload)', () => {
  it('maps the release row with its taskRollup and the artifact rows', () => {
    const out = shapeRelease(RELEASE_BODY, [ARTIFACT_ROW]);
    expect(out).toMatchObject({
      id: 'r1',
      releaseKey: 'REL-1',
      name: 'R1 2026',
      status: 'active',
      startDate: '2026-10-01',
      releaseDate: null,
      plannedVelocity: 30,
      planEstimate: 40,
      taskEstimate: 120,
      taskRollup: { estimateHours: 120, toDoHours: 60, actualHours: 20, acceptedItems: 2 },
    });
    expect(out.artifacts).toEqual([
      { id: 'w1', itemKey: 'PAY-1', type: 'story', title: 'Login bug', scheduleState: 'started' },
    ]);
    expect(out['truncated']).toBeUndefined();
  });

  it('keeps taskRollup distinct from the non-existent rollup/estimateHours fields', () => {
    const out = shapeRelease(RELEASE_BODY, []);
    expect(out).toHaveProperty('taskRollup');
    expect(out).not.toHaveProperty('rollup');
    expect(out).not.toHaveProperty('estimateHours');
    expect(out).not.toHaveProperty('acceptedItems');
  });

  it('omits taskRollup when the route left it off (optional field)', () => {
    const bare = { ...RELEASE_BODY, taskRollup: undefined };
    expect(shapeRelease(bare, [])).not.toHaveProperty('taskRollup');
  });
});
