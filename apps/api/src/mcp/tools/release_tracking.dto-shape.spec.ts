import { describe, expect, it } from 'vitest';
import { result } from './rest';

/**
 * The REAL ReleaseTrackingReport shape (GET /v1/reports/release-tracking,
 * reporting.controller.ts -> reporting.service.getReleaseTracking): the plan summary, the
 * three bucket totals, the burnup chart and the ACTIVE BUCKET's paged rows. Relayed AS-IS.
 */
const RELEASE_TRACKING_BODY = {
  context: { projectId: 'p1', releaseId: 'r1', unit: 'points', bucket: 'direct' },
  preliminary: { count: 5, points: 34 },
  planned: { count: 4, points: 30 },
  accepted: { count: 2, points: 12 },
  direct: { count: 4, points: 30 },
  derived: { count: 0, points: 0 },
  unparented: { count: 1, points: 4 },
  burnup: [{ date: '2026-10-01', planned: 10, accepted: 4 }],
  rows: [
    { workItemId: 'w1', itemKey: 'PAY-1', title: 'Login bug', type: 'defect', bucket: 'direct' },
  ],
  page: 1,
  pageSize: 25,
  total: 5,
};

const ERROR_BODY = { statusCode: 404, message: 'Not Found', error: 'Not Found' };

describe('release_tracking relays the real ReleaseTrackingReport shape', () => {
  it('a 200 body passes through unchanged — never reshaped', () => {
    const out = result(200, RELEASE_TRACKING_BODY, RELEASE_TRACKING_BODY);
    expect('isError' in out && out.isError).toBeFalsy();
    expect(JSON.parse(out.content[0].text)).toEqual(RELEASE_TRACKING_BODY);
  });

  it('a denial relays the route status and error body as isError', () => {
    const out = result(404, ERROR_BODY, RELEASE_TRACKING_BODY);
    expect('isError' in out && out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ statusCode: 404, error: ERROR_BODY });
  });
});
