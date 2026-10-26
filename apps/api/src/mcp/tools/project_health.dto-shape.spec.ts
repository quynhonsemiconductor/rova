import { describe, expect, it } from 'vitest';
import { shapeHealthRow } from './project_health';
import { listResult } from './rest';

/**
 * The REAL ProjectHealthResponseDto shape (projects.controller.ts GET /health ->
 * ProjectHealthResponseSchema): a bare ARRAY of rows — id/key/name, nullable lead + sprint
 * name, and the three rollup counters. No pageInfo: the route bounds itself with `limit`.
 */
const HEALTH_ROWS = [
  {
    id: 'p1',
    key: 'PAY',
    name: 'Payments',
    leadId: 'u1',
    leadName: 'Ada',
    activeSprintName: 'Sprint 4',
    progressPercent: 62,
    openDefects: 3,
    blockedCount: 1,
  },
  {
    id: 'p2',
    key: 'NXP',
    name: 'NXP',
    leadId: null,
    leadName: null,
    activeSprintName: null,
    progressPercent: 0,
    openDefects: 0,
    blockedCount: 0,
  },
];

const ERROR_BODY = { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' };

describe('shapeHealthRow + listResult (ProjectHealthResponseDto[] -> tool payload)', () => {
  it('maps each row keeping the DTO field names, under the `projects` list key', () => {
    const out = listResult(200, HEALTH_ROWS, shapeHealthRow, 'projects');
    const body = JSON.parse(out.content[0].text);
    expect(body.projects).toHaveLength(2);
    expect(body.projects[0]).toEqual({
      id: 'p1',
      key: 'PAY',
      name: 'Payments',
      leadName: 'Ada',
      activeSprintName: 'Sprint 4',
      progressPercent: 62,
      openDefects: 3,
      blockedCount: 1,
    });
    // a bare-array route carries no pageInfo — none may be invented
    expect(body).not.toHaveProperty('pageInfo');
  });

  it('the no-role member gets an EMPTY list, not a denial (AccessService-scoped)', () => {
    const body = JSON.parse(listResult(200, [], shapeHealthRow, 'projects').content[0].text);
    expect(body.projects).toEqual([]);
  });

  it('a denial relays the route status as isError', () => {
    const out = listResult(401, ERROR_BODY, shapeHealthRow, 'projects');
    expect('isError' in out && out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ statusCode: 401, error: ERROR_BODY });
  });
});
