import { describe, expect, it } from 'vitest';
import {
  ReleaseArtifactSchema,
  ReleaseResponseSchema,
} from '@modules/releases/interface/http/dto/release-response.dto';
import { shapeRelease } from './get_release';

/**
 * `rova_get_release` composes TWO producer shapes:
 *  - GET /v1/releases/:id -> ReleaseResponseSchema: the roll-up is `taskRollup` (estimateHours,
 *    toDoHours, actualHours, acceptedItems) — there is NO top-level estimateHours/acceptedItems
 *    and NO `rollup`.
 *  - GET /v1/releases/:id/artifacts -> a PAGE of ReleaseArtifactSchema ({ data, pageInfo }) —
 *    not a bare array (the shape that broke the first draft of this tool).
 * Both fixtures `parse` through the real schemas, so producer drift fails HERE.
 */
const RELEASE_BODY = ReleaseResponseSchema.parse({
  id: '0194a000-0000-7000-8000-000000000001',
  workspaceId: '0194a000-0000-7000-8000-000000000002',
  projectId: '0194a000-0000-7000-8000-000000000003',
  releaseKey: 'REL-1',
  name: 'R1 2026',
  description: null,
  theme: null,
  status: 'active',
  startDate: '2026-06-01',
  releaseDate: '2026-06-30',
  plannedVelocity: 30,
  planEstimate: 40,
  notes: null,
  releaseNotes: null,
  version: null,
  releasedAt: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  taskEstimate: 120,
  taskRollup: { estimateHours: 120, toDoHours: 60, actualHours: 20, acceptedItems: 2 },
});

const ARTIFACT_PAGE = {
  data: [
    ReleaseArtifactSchema.parse({
      id: '0194a000-0000-7000-8000-000000000004',
      itemKey: 'US-1',
      type: 'story',
      title: 'Upgrade NX workspace to v21',
      scheduleState: 'in_progress',
      priority: 'high',
      assigneeId: null,
      assigneeName: 'Member One',
      iterationId: null,
      releaseId: '0194a000-0000-7000-8000-000000000001',
      storyPoints: 5,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    }),
  ],
  pageInfo: { nextCursor: null, hasNextPage: false },
};

describe('shapeRelease (ReleaseResponseDto + artifacts page -> tool payload)', () => {
  it('maps the release row with its taskRollup and the artifact rows', () => {
    const out = shapeRelease(RELEASE_BODY, ARTIFACT_PAGE.data);
    expect(out).toMatchObject({
      id: RELEASE_BODY.id,
      releaseKey: 'REL-1',
      name: 'R1 2026',
      status: 'active',
      startDate: '2026-06-01',
      releaseDate: '2026-06-30',
      plannedVelocity: 30,
      planEstimate: 40,
      taskEstimate: 120,
      taskRollup: { estimateHours: 120, toDoHours: 60, actualHours: 20, acceptedItems: 2 },
    });
    expect(out.artifacts).toEqual([
      {
        id: ARTIFACT_PAGE.data[0].id,
        itemKey: 'US-1',
        type: 'story',
        title: 'Upgrade NX workspace to v21',
        scheduleState: 'in_progress',
      },
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
