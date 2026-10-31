import { describe, expect, it } from 'vitest';
import { DefectListResponseSchema } from '@modules/quality/interface/http/dto/defect-response.dto';
import { shapeDefects } from './quality_defects';

/**
 * The REAL DefectListResponse shape: { metrics, data, total } (offset-paged grid). The fixture
 * parses through the producer's own zod schema, so a DTO change breaks THIS test instead of
 * shipping a tool mapping a body the route never sends.
 */
const LIST_BODY = DefectListResponseSchema.parse({
  metrics: {
    openDefects: 2,
    critical: 1,
    inProgress: 1,
    verifiedAccepted: 0,
    reopened: 0,
    blockers: 0,
  },
  data: [
    {
      id: '0194a000-0000-7000-8000-00000000000d',
      itemKey: 'PAY-DE-1',
      title: 'Crash on submit',
      type: 'defect',
      priority: 'high',
      severity: 'critical',
      foundInEnvironment: 'production',
      rootCause: 'code',
      resolution: 'by_design',
      foundInReleaseId: null,
      foundInReleaseName: null,
      assigneeId: null,
      teamId: null,
      assigneeName: 'Member One',
      scheduleState: 'in_progress',
      iterationId: null,
      iterationName: null,
      releaseId: null,
      releaseName: null,
      parentId: null,
      parentKey: null,
      parentTitle: null,
      isBlocked: false,
      defectState: 'open',
      fixedInBuild: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
    {
      id: '0194a000-0000-7000-8000-00000000000e',
      itemKey: 'PAY-DE-2',
      title: 'Minor typo in the footer',
      type: 'defect',
      priority: 'low',
      severity: 'trivial',
      foundInEnvironment: 'staging',
      rootCause: 'other',
      resolution: 'wont_fix',
      foundInReleaseId: null,
      foundInReleaseName: null,
      assigneeId: null,
      teamId: null,
      assigneeName: null,
      scheduleState: 'completed',
      iterationId: null,
      iterationName: null,
      releaseId: null,
      releaseName: null,
      parentId: null,
      parentKey: null,
      parentTitle: null,
      isBlocked: false,
      defectState: 'closed',
      fixedInBuild: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    },
  ],
  total: 2,
});

describe('shapeDefects (DefectListResponse -> tool payload)', () => {
  it('maps the grid rows with defectState and relays total/offset', () => {
    const out = shapeDefects(LIST_BODY, 0);
    expect(out.total).toBe(2);
    expect(out.offset).toBe(0);
    expect(out.defects).toHaveLength(2);
    const first = (out.defects as Record<string, unknown>[])[0];
    expect(first).toMatchObject({
      id: LIST_BODY.data[0].id,
      itemKey: 'PAY-DE-1',
      title: 'Crash on submit',
      severity: 'critical',
      priority: 'high',
      defectState: 'open',
    });
  });

  it('computes hasMore from offset + page vs total — not a route field', () => {
    expect(shapeDefects(LIST_BODY, 0).hasMore).toBe(false);
    const big = {
      ...LIST_BODY,
      total: 25,
      data: LIST_BODY.data.concat([LIST_BODY.data[0]]),
    };
    expect(shapeDefects(big, 20).hasMore).toBe(true);
  });

  it('keeps defectState distinct from status (no status field exists on the DTO)', () => {
    const out = shapeDefects(LIST_BODY, 0);
    for (const d of out.defects as Record<string, unknown>[]) {
      expect(d).toHaveProperty('defectState');
      expect(d).not.toHaveProperty('status');
    }
  });
});
