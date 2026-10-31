import { describe, expect, it } from 'vitest';
import { WorkItemResponseSchema } from '@modules/work-items/interface/http/dto/work-item-response.dto';
import { shapeWorkItem } from './get_work_item';

/**
 * `rova_get_work_item` maps WorkItemResponseSchema (GET /v1/work-items/:id) on both ends of
 * the type spectrum: a STORY and a DEFECT. The fixture parses through the REAL schema, so a
 * renamed or removed DTO field breaks this test — the tool may never invent one.
 */
function storyFixture() {
  return WorkItemResponseSchema.parse({
    id: '0194a000-0000-7000-8000-000000000001',
    workspaceId: '0194a000-0000-7000-8000-000000000002',
    projectId: '0194a000-0000-7000-8000-000000000003',
    itemKey: 'US-1',
    type: 'story',
    title: 'Upgrade NX workspace to v21',
    description: null,
    statusId: '0194a000-0000-7000-8000-000000000004',
    scheduleState: 'in_progress',
    flowState: 'in_progress',
    priority: 'high',
    assigneeId: '0194a000-0000-7000-8000-000000000005',
    assigneeName: 'Ada',
    devOwnerName: 'Grace',
    reporterId: null,
    parentId: null,
    teamId: '0194a000-0000-7000-8000-000000000006',
    iterationId: '0194a000-0000-7000-8000-000000000007',
    releaseId: '0194a000-0000-7000-8000-000000000008',
    featureId: null,
    storyPoints: 5,
    estimateHours: 8,
    todoHours: 4,
    actualHours: null,
    acceptanceCriteria: 'it works',
    notes: null,
    releaseNotes: null,
    isBlocked: false,
    blockedReason: null,
    rank: '1000',
    customFields: {},
    createdBy: '0194a000-0000-7000-8000-000000000009',
    updatedBy: null,
    severity: null,
    foundInEnvironment: null,
    foundInReleaseId: null,
    rootCause: null,
    resolution: null,
    devOwnerId: null,
    defectState: null,
    fixedInBuild: null,
    startDate: '2026-06-17',
    targetEndDate: '2026-06-25',
    actualEndDate: null,
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  });
}

const DEFECT_ROW = WorkItemResponseSchema.parse({
  ...storyFixture(),
  id: '0194a000-0000-7000-8000-00000000000a',
  itemKey: 'DE-1',
  type: 'defect',
  severity: 'critical',
  defectState: 'open',
  rootCause: 'code',
  resolution: 'unresolved',
  featureId: '0194a000-0000-7000-8000-00000000000b',
});

describe('shapeWorkItem (WorkItemResponseDto -> tool payload)', () => {
  it('maps the story fields including the extended schedule/rollup ones', () => {
    const out = shapeWorkItem(storyFixture());
    expect(out).toMatchObject({
      id: storyFixture().id,
      itemKey: 'US-1',
      type: 'story',
      scheduleState: 'in_progress',
      devOwnerName: 'Grace',
      estimateHours: 8,
      todoHours: 4,
      teamId: '0194a000-0000-7000-8000-000000000006',
      iterationId: '0194a000-0000-7000-8000-000000000007',
      releaseId: '0194a000-0000-7000-8000-000000000008',
      isBlocked: false,
      startDate: '2026-06-17',
      targetEndDate: '2026-06-25',
      actualEndDate: null,
    });
    // defect fields exist but are null on a story — never undefined
    expect(out.severity).toBeNull();
    expect(out.defectState).toBeNull();
  });

  it('maps the defect-specific fields with the DTO names', () => {
    const out = shapeWorkItem(DEFECT_ROW);
    expect(out).toMatchObject({
      severity: 'critical',
      defectState: 'open',
      rootCause: 'code',
      resolution: 'unresolved',
    });
    expect(out).not.toHaveProperty('status');
  });
});
