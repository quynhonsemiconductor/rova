import { describe, expect, it } from 'vitest';
import {
  NO_TEAM_LABEL,
  UNASSIGNED_LABEL,
  attributeActualHours,
  describeEmptiness,
  rollUpTeamCapacity,
  type CapacityRecord,
  type ScopedTaskHours,
} from './team-capacity';

const capacity = (over: Partial<CapacityRecord> = {}): CapacityRecord => ({
  teamId: 'core',
  teamName: 'Core Platform',
  teamArchived: false,
  memberId: 'u1',
  memberName: 'Marcus Webb',
  capacityHours: 96,
  ...over,
});

const task = (over: Partial<ScopedTaskHours> = {}): ScopedTaskHours => ({
  taskId: 't1',
  teamId: 'core',
  teamName: 'Core Platform',
  teamArchived: false,
  ownerId: 'u1',
  ownerName: 'Marcus Webb',
  estimateHours: 6,
  todoHours: 0,
  actualHours: 6,
  ...over,
});

describe('rollUpTeamCapacity (Team Capacity §3, §4)', () => {
  it('keeps a member with capacity and no tasks visible (example 4)', () => {
    const r = rollUpTeamCapacity({
      capacities: [capacity({ memberId: 'u9', memberName: 'Priya Nair', capacityHours: 60 })],
      tasks: [],
    });
    expect(r.teams[0].members).toEqual([
      {
        id: 'u9',
        name: 'Priya Nair',
        hours: { capacityHours: 60, estimateHours: 0, todoHours: 0, actualHours: 0 },
      },
    ]);
  });

  it('keeps a task owner with no capacity record visible at 0h capacity (example 5)', () => {
    // A missing capacity record is a planning gap, never inferred from task hours.
    const r = rollUpTeamCapacity({
      capacities: [],
      tasks: [
        task({
          ownerId: 'u7',
          ownerName: 'Sarah Chen',
          estimateHours: 18,
          todoHours: 10,
          actualHours: 8,
        }),
      ],
    });
    expect(r.teams[0].members[0].hours).toEqual({
      capacityHours: 0,
      estimateHours: 18,
      todoHours: 10,
      actualHours: 8,
    });
  });

  it('shows a multi-Team person once inside each Team, never merged (§2)', () => {
    const r = rollUpTeamCapacity({
      capacities: [
        capacity({ capacityHours: 96 }),
        capacity({ teamId: 'iam', teamName: 'Identity & Access', capacityHours: 60 }),
      ],
      tasks: [],
    });
    expect(r.teams.map((t) => [t.name, t.totals.capacityHours])).toEqual([
      ['Core Platform', 96],
      ['Identity & Access', 60],
    ]);
    expect(r.totals.capacityHours).toBe(156);
  });

  it('makes every Team total the sum of its displayed member rows, and the grand total the sum of Teams', () => {
    const r = rollUpTeamCapacity({
      capacities: [
        capacity({ memberId: 'u1', capacityHours: 96 }),
        capacity({ memberId: 'u2', memberName: 'Sarah Chen', capacityHours: 82 }),
      ],
      tasks: [
        task({ taskId: 't1', ownerId: 'u1', estimateHours: 6, todoHours: 0, actualHours: 6 }),
        task({
          taskId: 't2',
          ownerId: 'u2',
          ownerName: 'Sarah Chen',
          estimateHours: 18,
          todoHours: 10,
          actualHours: 8,
        }),
      ],
    });
    // The mockup's Core Platform row: 178h / 24h / 10h / 14h.
    expect(r.teams[0].totals).toEqual({
      capacityHours: 178,
      estimateHours: 24,
      todoHours: 10,
      actualHours: 14,
    });
    expect(r.totals).toEqual(r.teams[0].totals);
  });

  it('de-duplicates tasks by task id before aggregating (§8)', () => {
    const r = rollUpTeamCapacity({
      capacities: [],
      tasks: [task({ taskId: 't1' }), task({ taskId: 't1' })],
    });
    expect(r.totals.estimateHours).toBe(6);
  });

  /**
   * `P6-TC-007`: an owner id that does not resolve to a user must not produce a named member row.
   * `ownerName` is a LEFT JOIN, so a removed account or a stale write left hours under a person the
   * reader cannot identify — the BA saw 6h/4h/2h under "No Team > Hieu Vu Minh Bui" for a task whose
   * Owner reads Unassigned.
   */
  it('treats an owner id with no resolvable user as Unassigned', () => {
    const r = rollUpTeamCapacity({
      capacities: [],
      tasks: [task({ taskId: 't3', ownerId: 'ghost-user', ownerName: null, estimateHours: 6 })],
    });
    const rows = r.teams[0].members;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeNull();
    expect(rows[0].name).toBe(UNASSIGNED_LABEL);
    expect(rows[0].hours.estimateHours).toBe(6);
  });

  it('groups an unowned task under Unassigned with 0h capacity (§4)', () => {
    const r = rollUpTeamCapacity({
      capacities: [capacity()],
      tasks: [task({ taskId: 't2', ownerId: null, ownerName: null, estimateHours: 4 })],
    });
    const unassigned = r.teams[0].members.find((m) => m.id === null);
    expect(unassigned?.name).toBe(UNASSIGNED_LABEL);
    expect(unassigned?.hours.capacityHours).toBe(0);
    expect(unassigned?.hours.estimateHours).toBe(4);
    // Unassigned sorts last so it cannot be mistaken for a person.
    expect(r.teams[0].members.at(-1)?.id).toBeNull();
  });

  it('groups work with no resolvable Team under No Team rather than dropping its hours', () => {
    // Team Capacity must add up to the same totals Team Status shows for the iteration, and
    // Team Status groups by member without needing a Team at all. Dropping these rows made the
    // two screens disagree; an honest heading does not.
    const r = rollUpTeamCapacity({
      capacities: [capacity()],
      tasks: [task({ taskId: 't9', teamId: null, teamName: null, estimateHours: 3 })],
    });
    const noTeam = r.teams.find((t) => t.id === null);
    expect(noTeam?.name).toBe(NO_TEAM_LABEL);
    expect(noTeam?.totals.estimateHours).toBe(3);
    // Sorts last, so it never reads as the first real Team.
    expect(r.teams.at(-1)?.id).toBeNull();
    expect(r.totals.estimateHours).toBe(3);
  });

  it('reports the values as-is: Actual is not capped and ToDo is not derived (example 6)', () => {
    const r = rollUpTeamCapacity({
      capacities: [],
      tasks: [task({ estimateHours: 6, todoHours: 2, actualHours: 8 })],
    });
    expect(r.totals.estimateHours).toBe(6);
    expect(r.totals.todoHours).toBe(2); // NOT estimate - actual
    expect(r.totals.actualHours).toBe(8); // NOT capped at estimate
  });

  it('rounds only the displayed values, after aggregating at full precision', () => {
    const r = rollUpTeamCapacity({
      capacities: [],
      tasks: [
        task({ taskId: 't1', estimateHours: 0.1, todoHours: 0, actualHours: 0 }),
        task({ taskId: 't2', estimateHours: 0.2, todoHours: 0, actualHours: 0 }),
      ],
    });
    expect(r.totals.estimateHours).toBe(0.3);
  });
});

describe('an archived Team', () => {
  it('KEEPS its hours and marks the row', () => {
    // "Archive Team does not delete the linked Work Item/Sprint history" (DB design §488). Dropping
    // the rows would shrink the report's total for a reason invisible on screen — and the global Team
    // picker already hides archived teams, so the badge is the only thing that can say why a
    // disbanded team is in the table.
    const r = rollUpTeamCapacity({
      capacities: [capacity({ teamArchived: true, capacityHours: 40 })],
      tasks: [task({ teamArchived: true, estimateHours: 12, todoHours: 4, actualHours: 8 })],
    });

    expect(r.teams).toHaveLength(1);
    expect(r.teams[0].archived).toBe(true);
    expect(r.teams[0].totals).toMatchObject({ capacityHours: 40, estimateHours: 12 });
    expect(r.totals.actualHours).toBe(8);
  });

  it('stays marked when only ONE of its two sources says so', () => {
    // The bucket is reached from both the capacity rows and the task rows. A task row whose `teams`
    // join missed — a team-less task resolved through its iteration, say — must not clear a flag the
    // capacity row set correctly, so the sources are ORed rather than last-write-wins.
    const r = rollUpTeamCapacity({
      capacities: [capacity({ teamArchived: true })],
      tasks: [task({ teamArchived: false })],
    });
    expect(r.teams[0].archived).toBe(true);
  });

  it('leaves a live Team unmarked, and the synthetic No Team group too', () => {
    const r = rollUpTeamCapacity({
      capacities: [capacity()],
      tasks: [task({ taskId: 't9', teamId: null, teamName: null })],
    });
    expect(r.teams.every((t) => t.archived === false)).toBe(true);
  });
});

describe('describeEmptiness', () => {
  it('separates "nobody planned capacity" from "nobody has scoped work"', () => {
    const capacityOnly = rollUpTeamCapacity({ capacities: [capacity()], tasks: [] });
    expect(describeEmptiness(capacityOnly)).toEqual({ hasCapacity: true, hasTaskHours: false });

    const tasksOnly = rollUpTeamCapacity({ capacities: [], tasks: [task()] });
    expect(describeEmptiness(tasksOnly)).toEqual({ hasCapacity: false, hasTaskHours: true });

    const nothing = rollUpTeamCapacity({ capacities: [], tasks: [] });
    expect(describeEmptiness(nothing)).toEqual({ hasCapacity: false, hasTaskHours: false });
    expect(nothing.teams).toEqual([]);
  });
});

/**
 * Phase 7 SU-10 — how much of a Task's Actual belongs to ONE Iteration (§8 Q1, plan 10.2/10.3).
 *
 * These are the FOUR Task shapes 10.7 enumerates plus the three-Iteration carry. The arithmetic is
 * tested here, without a database, because a sign error or a missing clamp is visible in one line;
 * WHICH Split row supplies each bound is a windowing question answered by SQL and proved by
 * `phase6-reports.e2e.spec.ts`.
 */
describe('attributeActualHours (SU-10, AC4/AC5)', () => {
  it('leaves a Task no Split ever moved on its full Actual (shape 1: no split row)', () => {
    // Both bounds absent: nothing arrived, nothing left, so the iteration owns every hour. This is
    // the overwhelming majority of rows and it must not change.
    expect(
      attributeActualHours({ actualHours: 6, actualAtArrival: null, actualAtDeparture: null }),
    ).toBe(6);
  });

  it('leaves a Task on the UNFINISHED side on its full Actual (shape 2)', () => {
    /**
     * A Task listed on the `unfinished` side did not move — it stayed in the source Iteration with the
     * placeholder. So the repository's `split_side = 'continued'` predicate finds no bound for it and
     * it reaches this function in exactly the shape above. Asserted as its own case rather than folded
     * into shape 1, because the CLAIM is different: "the placeholder's Tasks keep today's behaviour"
     * is a rule, and it holding by construction is the thing worth pinning.
     */
    expect(
      attributeActualHours({ actualHours: 4, actualAtArrival: null, actualAtDeparture: null }),
    ).toBe(4);
  });

  it('gives the target ZERO when no new work was logged after the Split (shape 3)', () => {
    // The source keeps all 3 (its own departure bound); the target has 3 → 3.
    expect(
      attributeActualHours({ actualHours: 3, actualAtArrival: 3, actualAtDeparture: null }),
    ).toBe(0);
    // And the source's own claim on the same Task, for the pair: nothing arrived, 3 left.
    expect(
      attributeActualHours({ actualHours: 3, actualAtArrival: null, actualAtDeparture: 3 }),
    ).toBe(3);
  });

  it('gives the target only the post-Split delta when new work was logged (shape 4)', () => {
    // 3 hours at the Split, 10 now: the target earned 7 and the source still reports 3.
    expect(
      attributeActualHours({ actualHours: 10, actualAtArrival: 3, actualAtDeparture: null }),
    ).toBe(7);
    expect(
      attributeActualHours({ actualHours: 10, actualAtArrival: null, actualAtDeparture: 3 }),
    ).toBe(3);
  });

  it('clamps a downward correction to 0 instead of contributing negative hours (§8 Q1a)', () => {
    /**
     * `actual_hours` is manually editable, so 3 recorded at the Split can be corrected to 2 afterwards.
     * Unclamped the target would contribute −1, which does not merely look wrong: it would subtract an
     * hour from a DIFFERENT member's row inside the same team total. The ruling is that the source
     * keeps its snapshot and the target contributes nothing.
     */
    expect(
      attributeActualHours({ actualHours: 2, actualAtArrival: 3, actualAtDeparture: null }),
    ).toBe(0);
    expect(
      attributeActualHours({ actualHours: 2, actualAtArrival: null, actualAtDeparture: 3 }),
    ).toBe(3);
  });

  it('windows a Task carried across THREE Iterations, middle one included (§8 Q1b)', () => {
    /**
     * Snapshots 3 then 7, currently at 10. Each Iteration's bounds come from its own position in the
     * chain, and the MIDDLE one is the case "the most recent split row" gets wrong — it would give I2
     * the 7 → 10 window that belongs to I3.
     */
    const total = 10;
    const i1 = attributeActualHours({
      actualHours: total,
      actualAtArrival: null,
      actualAtDeparture: 3,
    });
    const i2 = attributeActualHours({
      actualHours: total,
      actualAtArrival: 3,
      actualAtDeparture: 7,
    });
    const i3 = attributeActualHours({
      actualHours: total,
      actualAtArrival: 7,
      actualAtDeparture: null,
    });

    expect([i1, i2, i3]).toEqual([3, 4, 3]);
    // The property that matters across the whole chain: the hours are attributed ONCE, in full.
    expect(i1 + i2 + i3).toBe(total);
  });

  it('treats a 0 arrival bound as a real measurement, not as an absent one', () => {
    /**
     * A Split confirmed before anyone logged an hour snapshots `0`. `0` and `null` happen to produce
     * the same lower bound, so this case cannot fail today — it pins the DEPARTURE side, where they
     * differ completely: `0` means "this iteration owned it and nothing was logged", `null` means
     * "it never left, so count everything".
     */
    expect(attributeActualHours({ actualHours: 5, actualAtArrival: 0, actualAtDeparture: 0 })).toBe(
      0,
    );
    expect(
      attributeActualHours({ actualHours: 5, actualAtArrival: 0, actualAtDeparture: null }),
    ).toBe(5);
  });
});
