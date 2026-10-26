import { describe, expect, it } from 'vitest';
import { ReleaseTrackingResponseSchema } from '@modules/reporting/interface/http/dto/reporting-response.dto';
import { result } from './rest';

/**
 * `rova_release_tracking` relays the route payload AS-IS; the fixture is built through the
 * REAL ReleaseTrackingResponseSchema (`parse` throws on producer drift). Burnup is NOT here —
 * it is a separate route (/reports/release-tracking/burnup).
 */
const RELEASE_TRACKING_BODY = ReleaseTrackingResponseSchema.parse({
  context: {
    projectId: '0194a000-0000-7000-8000-000000000001',
    projectName: 'NXP',
    teamId: null,
    teamName: null,
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  release: {
    id: '0194a000-0000-7000-8000-000000000002',
    name: 'R1 2026',
    startDate: '2026-06-01',
    releaseDate: '2026-06-30',
  },
  unit: 'points',
  bucket: 'direct',
  summary: { direct: 1, derived: 0, unparented: 1 },
  rows: [
    {
      rank: 1,
      id: '0194a000-0000-7000-8000-000000000003',
      itemKey: 'US-1',
      name: 'Upgrade NX workspace to v21',
      teams: [{ id: null, name: 'Alpha' }],
      issueType: 'story',
      state: 'In Progress',
      childCount: 0,
      status: { accepted: 3, total: 5, percent: 60 },
      mismatches: [],
      fullMismatch: false,
      plannedStartDate: null,
      plannedEndDate: null,
      progress: {
        points: { accepted: 3, total: 5, percent: 60 },
        stories: { accepted: 1, total: 1, percent: 100 },
        defects: { accepted: 0, total: 0, percent: null },
      },
    },
  ],
  page: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
  totals: { planned: 5, accepted: 3, preliminary: 8 },
});

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
