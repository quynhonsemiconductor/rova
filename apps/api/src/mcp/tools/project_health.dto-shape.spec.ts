import { describe, expect, it } from 'vitest';
import { ProjectHealthResponseSchema } from '@modules/projects/interface/http/dto/project-response.dto';
import { listResult } from './rest';
import { shapeHealthRow } from './project_health';

/**
 * `rova_project_health` relays GET /v1/projects/health: a BARE array of
 * ProjectHealthResponseSchema rows (no pageInfo — the route bounds itself with `limit`).
 * The fixture parses through the REAL schema.
 */
const HEALTH_ROWS = [
  ProjectHealthResponseSchema.parse({
    id: '0194a000-0000-7000-8000-000000000001',
    key: 'PAY',
    name: 'Payments',
    leadId: null,
    leadName: null,
    activeSprintName: null,
    progressPercent: 62,
    openDefects: 3,
    blockedCount: 1,
  }),
  ProjectHealthResponseSchema.parse({
    id: '0194a000-0000-7000-8000-000000000002',
    key: 'NXP',
    name: 'NX Platform',
    leadId: '0194a000-0000-7000-8000-000000000003',
    leadName: 'Ada',
    activeSprintName: 'Sprint 25.14',
    progressPercent: 0,
    openDefects: 0,
    blockedCount: 0,
  }),
];

const ERROR_BODY = { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' };

describe('shapeHealthRow + listResult (ProjectHealthResponseDto[] -> tool payload)', () => {
  it('maps each row keeping the DTO field names, under the `projects` list key', () => {
    const out = listResult(200, HEALTH_ROWS, shapeHealthRow, 'projects');
    const body = JSON.parse(out.content[0].text);
    expect(body.projects).toHaveLength(2);
    expect(body.projects[1]).toEqual({
      id: HEALTH_ROWS[1].id,
      key: 'NXP',
      name: 'NX Platform',
      leadName: 'Ada',
      activeSprintName: 'Sprint 25.14',
      progressPercent: 0,
      openDefects: 0,
      blockedCount: 0,
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
