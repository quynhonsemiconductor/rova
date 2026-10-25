import { describe, expect, it } from 'vitest';
import { shapeDefects } from './quality_defects';

/** The real DefectListResponse shape: { metrics, data, total } (offset-paged grid). */
const LIST_BODY = {
  metrics: { openDefects: 2, critical: 1, inProgress: 1, verifiedAccepted: 0 },
  data: [
    {
      id: 'd1',
      itemKey: 'PAY-DE-1',
      title: 'Crash on submit',
      type: 'defect',
      priority: 'high',
      severity: 'critical',
      defectState: 'open',
      rootCause: 'code',
      resolution: 'unresolved',
      assigneeName: 'Member One',
    },
    {
      id: 'd2',
      itemKey: 'PAY-DE-2',
      title: 'Minor typo in the footer',
      type: 'defect',
      priority: 'low',
      severity: 'trivial',
      defectState: 'closed',
      rootCause: 'other',
      resolution: 'resolved',
      assigneeName: null,
    },
  ],
  total: 2,
};

describe('shapeDefects (DefectListResponse -> tool payload)', () => {
  it('maps the grid rows with defectState and relays total/offset', () => {
    const out = shapeDefects(LIST_BODY, 0);
    expect(out.total).toBe(2);
    expect(out.offset).toBe(0);
    expect(out.defects).toHaveLength(2);
    const first = (out.defects as Record<string, unknown>[])[0];
    expect(first).toMatchObject({
      id: 'd1',
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
