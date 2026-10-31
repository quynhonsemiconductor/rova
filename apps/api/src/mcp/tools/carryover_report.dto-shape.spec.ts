import { describe, expect, it } from 'vitest';
import { CarryoverReportResponseSchema } from '@modules/reporting/interface/http/dto/reporting-response.dto';
import { result } from './rest';

/**
 * `rova_carryover_report` relays the route payload AS-IS, so the fixture IS the contract:
 * built through the REAL CarryoverReportResponseSchema (`parse` throws here if the producer
 * DTO changes shape), never hand-typed.
 */
const CARRYOVER_BODY = CarryoverReportResponseSchema.parse({
  context: {
    projectId: '0194a000-0000-7000-8000-000000000001',
    projectName: 'NXP',
    teamId: null,
    teamName: null,
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  timebox: {
    iterationId: '0194a000-0000-7000-8000-000000000002',
    timeboxGroupId: null,
    name: 'Sprint 25.14',
    startDate: '2026-06-16',
    endDate: '2026-06-27',
    iterationCount: 1,
  },
  direction: 'all',
  kpis: { carryIn: 2, carryOut: 1, transferredTodoHours: 5, carryoverRate: 25 },
  trend: [
    {
      iterationId: '0194a000-0000-7000-8000-000000000003',
      name: 'Sprint 25.13',
      startDate: '2026-06-01',
      carryIn: 0,
      carryOut: 2,
    },
  ],
  rows: [
    {
      transitionId: '0194a000-0000-7000-8000-000000000004',
      direction: 'out',
      storyId: '0194a000-0000-7000-8000-000000000005',
      storyKey: 'US-9',
      storyTitle: 'Login bug',
      fromIterationId: '0194a000-0000-7000-8000-000000000002',
      fromIterationName: 'Sprint 25.14',
      toIterationId: '0194a000-0000-7000-8000-000000000006',
      toIterationName: 'Sprint 26.2',
      movedAt: '2026-06-20T08:00:00.000Z',
      startDate: null,
      targetEndDate: '2026-07-01',
      estimateHours: 8,
      todoHours: 5,
      actualBefore: 3,
      actualAfter: 3,
    },
  ],
});

const ERROR_BODY = { statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' };

describe('carryover_report relays the real CarryoverReport shape', () => {
  it('a 200 body passes through unchanged — never reshaped', () => {
    const out = result(200, CARRYOVER_BODY, CARRYOVER_BODY);
    expect('isError' in out && out.isError).toBeFalsy();
    expect(JSON.parse(out.content[0].text)).toEqual(CARRYOVER_BODY);
  });

  it('a denial relays the route status and error body as isError', () => {
    const out = result(403, ERROR_BODY, CARRYOVER_BODY);
    expect('isError' in out && out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ statusCode: 403, error: ERROR_BODY });
  });
});
