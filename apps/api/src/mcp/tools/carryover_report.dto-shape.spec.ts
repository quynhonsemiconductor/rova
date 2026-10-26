import { describe, expect, it } from 'vitest';
import { result } from './rest';

/**
 * The REAL CarryoverReport shape (GET /v1/reports/carryover, reporting.controller.ts ->
 * reporting.service.getCarryover): context header, the carry KPIs, rate, trend and rows.
 * `carryover_report` relays this payload AS-IS — this spec pins the relay on the real shape,
 * and the denial pass-through the same body would take on a 403.
 */
const CARRYOVER_BODY = {
  context: { projectId: 'p1', projectName: 'PAY', iterationId: 'i1', iterationName: 'Sprint 4' },
  carryIn: { count: 2, points: 8 },
  carryOut: { count: 1, points: 3 },
  transferredTodo: { count: 1, points: 2 },
  rate: 25,
  trend: [{ label: 'Sprint 3', rate: 20 }],
  rows: [
    {
      workItemId: 'w1',
      itemKey: 'PAY-1',
      title: 'Login bug',
      type: 'defect',
      transition: 'CARRY_IN',
      storyPoints: 5,
    },
  ],
};

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
