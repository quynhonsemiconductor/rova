/** The Carryover read model — one formula per test (plan §5, BR-36…41). */
import { describe, expect, it } from 'vitest';

import {
  actualAfter,
  buildCarryoverRows,
  buildTrend,
  carryoverRate,
  involving,
  nextSnapshotIndex,
  summarise,
  type StoredCarryoverEvent,
} from './carryover';

function event(
  id: string,
  at: string,
  from: string | null,
  to: string | null,
  tasks: StoredCarryoverEvent['tasks'],
  storyId = 's1',
): StoredCarryoverEvent {
  return {
    transitionId: id,
    occurredAt: at,
    storyId,
    storyKey: storyId.toUpperCase(),
    storyTitle: 'Story',
    storyStartDate: '2026-06-02',
    targetEndDate: '2026-06-20',
    sourceIterationId: from,
    sourceIterationName: from,
    targetIterationId: to,
    targetIterationName: to,
    tasks,
  };
}

const task = (actual: number | null, current = 10, todo: number | null = 2, estimate = 4) => ({
  taskId: 't1',
  estimateHours: estimate,
  todoHours: todo,
  actualHours: actual,
  currentActualHours: current,
});

// A→B with Actual 3, then B→C with Actual 7, Actual now 10 (plan Task 9: A=3, B=4, C=3).
const AB = event('e1', '2026-06-15T01:00:00.000Z', 'A', 'B', [task(3)]);
const BC = event('e2', '2026-06-29T01:00:00.000Z', 'B', 'C', [task(7)]);

describe('summarise', () => {
  it('counts a move between two Iterations of the set ONCE, as Carry In (matches its row)', () => {
    const summary = summarise([AB], ['A', 'B']);
    expect([summary?.carryIn, summary?.carryOut]).toEqual([1, 0]);
    expect(summary?.transferredTodoHours).toBe(2);
  });
  it('counts Carry In for the target', () => {
    expect(summarise([AB, BC], ['B'])?.carryIn).toBe(1);
  });
  it('counts Carry Out for the source', () => {
    expect(summarise([AB, BC], ['B'])?.carryOut).toBe(1);
  });
  it('sums snapshot To Do over involving events, each once', () => {
    expect(summarise([AB, BC], ['B'])?.transferredTodoHours).toBe(4);
  });
  it('is null when nothing touches the set', () => {
    expect(summarise([AB], ['Z'])).toBeNull();
  });
  it('treats a null To Do as absent, not as a number', () => {
    const e = event('e3', '2026-06-01T00:00:00.000Z', 'A', 'B', [task(0, 0, null)]);
    expect(summarise([e], ['A'])?.transferredTodoHours).toBe(0);
  });
});

describe('actualAfter (D10 window)', () => {
  it('bounds by the next Carryover of the same Task', () => {
    expect(actualAfter(AB, [AB, BC])).toBe(4);
  });
  it('runs to the current Actual for the last hop', () => {
    expect(actualAfter(BC, [AB, BC])).toBe(3);
  });
  it('clamps a downward correction at 0', () => {
    const e = event('e4', '2026-06-15T00:00:00.000Z', 'A', 'B', [task(5, 2)]);
    expect(actualAfter(e, [e])).toBe(0);
  });
});

describe('buildCarryoverRows', () => {
  it('lists every involving event oldest first, with SRS columns', () => {
    const rows = buildCarryoverRows([BC, AB], ['B'], 'all');
    expect(rows.map((r) => [r.transitionId, r.direction])).toEqual([
      ['e1', 'in'],
      ['e2', 'out'],
    ]);
    expect(rows[0]).toMatchObject({
      estimateHours: 4,
      todoHours: 2,
      actualBefore: 3,
      actualAfter: 4,
    });
  });
  it('Direction In keeps only arrivals', () => {
    expect(buildCarryoverRows([AB, BC], ['B'], 'in').map((r) => r.transitionId)).toEqual(['e1']);
  });
  it('Direction Out keeps only departures', () => {
    expect(buildCarryoverRows([AB, BC], ['B'], 'out').map((r) => r.transitionId)).toEqual(['e2']);
  });
  it('labels a move between two Iterations of the set `in`, and keeps it OUT of the Out tab', () => {
    // A→B where BOTH are in the reported set (one fused timebox): the set received the Story.
    const rows = buildCarryoverRows([AB], ['A', 'B'], 'all');
    expect(rows.map((r) => r.direction)).toEqual(['in']);
    expect(buildCarryoverRows([AB], ['A', 'B'], 'in')).toHaveLength(1);
    expect(buildCarryoverRows([AB], ['A', 'B'], 'out')).toHaveLength(0);
  });
  it('every row under a Direction tab carries that Direction', () => {
    for (const direction of ['in', 'out'] as const) {
      for (const row of buildCarryoverRows([AB, BC], ['A', 'B', 'C'], direction)) {
        expect(row.direction).toBe(direction);
      }
    }
  });
});

describe('nextSnapshotIndex', () => {
  it('gives the same Actual After as the per-row lookup, regardless of input order', () => {
    const index = nextSnapshotIndex([BC, AB]);
    expect(actualAfter(AB, [BC, AB], index)).toBe(4);
    expect(actualAfter(BC, [BC, AB], index)).toBe(3);
  });
  it('has no entry for a Task’s last hop', () => {
    expect(nextSnapshotIndex([AB, BC]).has('e2:t1')).toBe(false);
  });
});

describe('carryoverRate (R11)', () => {
  it('divides affected Stories by scheduled ∪ carried-out Stories', () => {
    // B: s1 arrived then left; s2, s3 are still scheduled. Affected {s1}; denominator {s1,s2,s3}.
    expect(carryoverRate([AB, BC], ['B'], ['s2', 's3'])).toBe(33.3);
  });
  it('is 0 when the denominator is 0', () => {
    expect(carryoverRate([], ['B'], [])).toBe(0);
  });
  it('counts a Story with two events once', () => {
    expect(carryoverRate([AB, BC], ['B'], [])).toBe(100);
  });
});

describe('buildTrend', () => {
  it('counts in/out per Iteration in the given order', () => {
    const trend = buildTrend(
      [AB, BC],
      [
        { id: 'A', name: 'A', startDate: '2026-06-01' },
        { id: 'B', name: 'B', startDate: '2026-06-15' },
        { id: 'C', name: 'C', startDate: '2026-06-29' },
      ],
    );
    expect(trend.map((t) => [t.iterationId, t.carryIn, t.carryOut])).toEqual([
      ['A', 0, 1],
      ['B', 1, 1],
      ['C', 1, 0],
    ]);
  });
});

describe('involving', () => {
  it('ignores events with neither end in the set', () => {
    expect(involving([AB, BC], ['A'])).toEqual([AB]);
  });
});
