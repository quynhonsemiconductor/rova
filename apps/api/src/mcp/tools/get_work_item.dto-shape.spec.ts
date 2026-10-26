import { describe, expect, it } from 'vitest';
import { shapeWorkItem } from './get_work_item';

/**
 * The REAL WorkItemResponseDto shape (work-items.controller.ts GET :id -> WorkItemResponseSchema),
 * on the two ends of the type spectrum the tool maps: a STORY and a DEFECT. The extension adds
 * the schedule/rollup/defect fields the detail page shows — this spec pins them to the DTO's
 * names (defectState, NOT status; the date fields are YYYY-MM-DD strings).
 */
const STORY_ROW = {
  id: 'w1',
  workspaceId: 'ws1',
  projectId: 'p1',
  itemKey: 'PAY-1',
  type: 'story',
  title: 'Login',
  description: null,
  statusId: 's1',
  scheduleState: 'started',
  flowState: null,
  priority: 'high',
  assigneeId: 'u1',
  assigneeName: 'Ada',
  devOwnerName: 'Grace',
  reporterId: 'u2',
  parentId: null,
  teamId: 't1',
  iterationId: 'i1',
  releaseId: 'r1',
  featureId: null,
  storyPoints: 5,
  estimateHours: 8,
  todoHours: 4,
  actualHours: null,
  acceptanceCriteria: 'it works',
  isBlocked: false,
  blockedReason: null,
  rank: '1000',
  severity: null,
  defectState: null,
  rootCause: null,
  resolution: null,
  startDate: '2026-10-02',
  targetEndDate: '2026-10-10',
  actualEndDate: null,
  updatedAt: '2026-10-03T00:00:00.000Z',
};

const DEFECT_ROW = {
  ...STORY_ROW,
  id: 'w2',
  itemKey: 'PAY-DE-1',
  type: 'defect',
  severity: 'critical',
  defectState: 'open',
  rootCause: 'code',
  resolution: 'unresolved',
  featureId: 'f1',
};

describe('shapeWorkItem (WorkItemResponseDto -> tool payload)', () => {
  it('maps the story fields including the extended schedule/rollup ones', () => {
    const out = shapeWorkItem(STORY_ROW);
    expect(out).toMatchObject({
      id: 'w1',
      itemKey: 'PAY-1',
      type: 'story',
      scheduleState: 'started',
      devOwnerName: 'Grace',
      estimateHours: 8,
      todoHours: 4,
      teamId: 't1',
      iterationId: 'i1',
      releaseId: 'r1',
      isBlocked: false,
      startDate: '2026-10-02',
      targetEndDate: '2026-10-10',
      actualEndDate: null,
      updatedAt: '2026-10-03T00:00:00.000Z',
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
