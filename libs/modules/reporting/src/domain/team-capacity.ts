import { roundForDisplay } from './report-scope';

/**
 * Team Capacity roll-up (Team Capacity SRS §3 and §4).
 *
 * A read-only PROJECTION of the same capacity and task-hour sources `Track > Team Status`
 * uses. It must not maintain a separate capacity store, so nothing here writes and the
 * repository reads `member_capacity` + `tasks` — the same tables Team Status reads.
 */

export interface TeamCapacityHours {
  capacityHours: number;
  estimateHours: number;
  todoHours: number;
  actualHours: number;
}

/** A member's capacity row for the selected project/team/iteration. */
export interface CapacityRecord {
  teamId: string;
  teamName: string;
  /**
   * The Team has been archived (`teams.status = 'archived'`).
   *
   * Its hours are still reported — "Archive Team does not delete the linked Work Item/Sprint
   * history" (DB design §488), and a total that quietly shrinks when a team is disbanded is worse
   * than one that explains itself. But an archived team is not comparable to a live one, and the
   * global Team picker already hides it, so nothing else on screen would tell a reader that this
   * row belongs to a team that no longer exists.
   */
  teamArchived: boolean;
  memberId: string;
  memberName: string;
  capacityHours: number;
}

/** One task in scope, already narrowed. `ownerId` null = unassigned. */
export interface ScopedTaskHours {
  /** Stable task id — the de-duplication key (§8). */
  taskId: string;
  /**
   * Null when neither the task, its parent Story/Defect nor the iteration carries a Team.
   * Grouped under `No Team` rather than dropped: the report has to add up to the same totals
   * Team Status shows, and hours that vanish are worse than hours under an honest heading.
   */
  teamId: string | null;
  teamName: string | null;
  /** See {@link CapacityRecord.teamArchived}. False when the Team cannot be resolved at all. */
  teamArchived: boolean;
  ownerId: string | null;
  ownerName: string | null;
  estimateHours: number;
  todoHours: number;
  /**
   * Actual hours ALREADY ATTRIBUTED to the requested Iteration (Phase 7 SU-10, SRS §10.5).
   *
   * For a Task no Split ever moved this is simply `tasks.actual_hours`, and that is the overwhelming
   * majority. For a Task carried forward by a Split it is the slice of that scalar which belongs to
   * the iteration being reported — see {@link attributeActualHours}. The repository applies the
   * arithmetic because the WINDOW needs the iteration ids, which the roll-up below does not have.
   *
   * Task Detail deliberately shows something different: the FULL accumulated Actual, from
   * `getTaskTotals`, which must never get this attribution (SU-10 10.5).
   */
  actualHours: number;
}

/**
 * What one Task's Split history says about ONE iteration's claim on its Actual hours.
 *
 * `tasks.actual_hours` is a single manually-edited scalar with NO temporal dimension —
 * `0052_task_actual_hours_manual.sql` dropped the `time_logs` → `actual_hours` trigger, and
 * `time_logs` is per-work-item and per-date, feeds no report, and cannot stand in for it. So when a
 * Task follows `[Continued]` into the next Iteration, its ENTIRE accumulated Actual would move with
 * it: gone from the source, arriving whole in the target. The only durable record of "how much had
 * been logged by then" is the Split Event's per-Task snapshot (`story_split_items.actual_hours_at_split`),
 * which is why plan §2.2 stores it.
 *
 * The two bounds are chosen by an explicit WINDOW over the Task's `continued`-side Split rows, not by
 * "the most recent one" — a Task carried across three Iterations has three rows, and "most recent"
 * gives the middle Iteration the wrong answer from the third Iteration on (§8 Q1b).
 */
export interface TaskActualWindow {
  /** `tasks.actual_hours` as it stands NOW — the full accumulated scalar. */
  actualHours: number;
  /**
   * `actual_hours_at_split` of the LATEST Split that carried this Task INTO the reported iteration.
   *
   * Null when the Task did not arrive by a Split, i.e. it has been here since it was created — then
   * the iteration's claim starts at zero.
   */
  actualAtArrival: number | null;
  /**
   * `actual_hours_at_split` of the EARLIEST Split that carried this Task OUT of the reported
   * iteration.
   *
   * Null when the Task never left — then the claim runs to whatever is logged today. EARLIEST rather
   * than latest, because the first departure is when this iteration stopped owning the work.
   */
  actualAtDeparture: number | null;
}

/**
 * How many of a Task's Actual hours belong to the reported Iteration.
 *
 * `max(0, upper − lower)`, with the bounds defaulting to "everything logged so far" and "zero".
 *
 * Worked example — one Task carried across three Iterations, snapshots 3 then 7, now at 10 hours:
 *   • I1 (source of the first Split): arrival null, departure 3   → 3
 *   • I2 (target of the first, source of the second): 3 → 7       → 4
 *   • I3 (target of the second, never left): 7 → 10               → 3
 * Ten hours, once. A Task on the `unfinished` side of a Split never moved, so it has no
 * `continued`-side row for that Split and keeps today's behaviour by construction.
 *
 * THE CLAMP IS §8 Q1a'S RULING, NOT DEFENSIVENESS. `actual_hours` is manually editable, so a
 * correction DOWNWARDS after the Split can leave the current value below the snapshot: 3 hours
 * recorded at the Split, later corrected to 2. Unclamped, the target would contribute −1 and would
 * silently eat an hour from another member's row in the same total. The ruling is that the source
 * keeps its snapshot and the target contributes `0`; the correction is therefore visible as a
 * disagreement between Task Detail and this report, which is honest, rather than as a negative
 * number, which is not.
 *
 * KNOWN LIMITATION, §8 Q1c, accepted by the product owner: hours edited retroactively for work done
 * BEFORE a Split are attributed to the target, because nothing about the number says when it was
 * earned. There is no reconstruction that could know otherwise.
 */
export function attributeActualHours(window: TaskActualWindow): number {
  const lower = window.actualAtArrival ?? 0;
  const upper = window.actualAtDeparture ?? window.actualHours;
  return Math.max(0, upper - lower);
}

export interface TeamCapacityMemberRow {
  /** Null for the synthetic `Unassigned` group. */
  id: string | null;
  name: string;
  hours: TeamCapacityHours;
}

export interface TeamCapacityTeamRow {
  /** Null for the synthetic `No Team` group. */
  id: string | null;
  name: string;
  /** See {@link CapacityRecord.teamArchived}. */
  archived: boolean;
  totals: TeamCapacityHours;
  members: TeamCapacityMemberRow[];
}

export interface TeamCapacityRollup {
  totals: TeamCapacityHours;
  teams: TeamCapacityTeamRow[];
}

const ZERO: TeamCapacityHours = {
  capacityHours: 0,
  estimateHours: 0,
  todoHours: 0,
  actualHours: 0,
};

/** The label the `Unassigned` group carries when a scoped task has no owner (§4). */
export const UNASSIGNED_LABEL = 'Unassigned';

/** The label for work whose Team cannot be resolved at all — see `ScopedTaskHours.teamId`. */
export const NO_TEAM_LABEL = 'No Team';

function add(a: TeamCapacityHours, b: Partial<TeamCapacityHours>): TeamCapacityHours {
  return {
    capacityHours: a.capacityHours + (b.capacityHours ?? 0),
    estimateHours: a.estimateHours + (b.estimateHours ?? 0),
    todoHours: a.todoHours + (b.todoHours ?? 0),
    actualHours: a.actualHours + (b.actualHours ?? 0),
  };
}

function round(h: TeamCapacityHours): TeamCapacityHours {
  return {
    capacityHours: roundForDisplay(h.capacityHours),
    estimateHours: roundForDisplay(h.estimateHours),
    todoHours: roundForDisplay(h.todoHours),
    actualHours: roundForDisplay(h.actualHours),
  };
}

/**
 * Build the Team → Member table.
 *
 * MEMBER INCLUSION IS A UNION, NOT AN INTERSECTION (§4)
 *
 * Members with a capacity record but no tasks stay visible (planned capacity nobody has
 * work for is a planning signal), and task owners with no capacity record are not
 * silently dropped (they show `0h` capacity, which is a data-quality gap — never inferred
 * from their task hours).
 *
 * A person on two Teams appears ONCE INSIDE EACH Team. Their rows are not merged: the
 * report answers "what is this Team committed to", and merging would make one Team's
 * numbers depend on another's.
 *
 * Tasks are de-duplicated by task id before aggregation (§8), which matters for All Teams
 * where the same task can be reached through more than one join path.
 */
export function rollUpTeamCapacity(input: {
  capacities: readonly CapacityRecord[];
  tasks: readonly ScopedTaskHours[];
}): TeamCapacityRollup {
  interface Bucket {
    id: string | null;
    name: string;
    archived: boolean;
    members: Map<string, TeamCapacityMemberRow>;
  }
  const teams = new Map<string, Bucket>();

  const team = (id: string | null, name: string, archived: boolean): Bucket => {
    const key = id ?? NO_TEAM_LABEL;
    const existing = teams.get(key);
    if (existing) {
      // ORed across sources rather than taken from whichever record happened to create the
      // bucket: a team is reached through BOTH the capacity rows and the task rows, and a row
      // whose `teams` join missed would otherwise clear a flag another row had set right.
      existing.archived = existing.archived || archived;
      return existing;
    }
    const created: Bucket = { id, name, archived, members: new Map() };
    teams.set(key, created);
    return created;
  };

  const member = (bucket: Bucket, key: string, id: string | null, name: string) => {
    const existing = bucket.members.get(key);
    if (existing) return existing;
    const created: TeamCapacityMemberRow = { id, name, hours: { ...ZERO } };
    bucket.members.set(key, created);
    return created;
  };

  // 1. Capacity records first, so a member with capacity and no tasks still has a row.
  for (const record of input.capacities) {
    const bucket = team(record.teamId, record.teamName, record.teamArchived);
    const row = member(bucket, record.memberId, record.memberId, record.memberName);
    // Additive rather than assigned: the unique index makes one row per
    // (project, team, iteration, member), but summing means a duplicate would show up as
    // a wrong total rather than a silently dropped record.
    row.hours = add(row.hours, { capacityHours: record.capacityHours });
  }

  // 2. Task hours, de-duplicated by task id.
  const seenTasks = new Set<string>();
  for (const task of input.tasks) {
    if (seenTasks.has(task.taskId)) continue;
    seenTasks.add(task.taskId);
    const bucket = team(task.teamId, task.teamName ?? NO_TEAM_LABEL, task.teamArchived);
    /**
     * An owner counts as NAMED only when it resolves to a real user.
     *
     * `P6-TC-007` (DEV Handoff 2026-08-14): "Task TA-2 keeps Owner = Unassigned, but Team Capacity
     * attributes 6h Estimate, 4h To Do and 2h Actual to No Team > Hieu Vu Minh Bui instead of an
     * Unassigned group… an unassigned Task must not be attributed to a named member."
     *
     * `ownerName` comes from a LEFT JOIN on `users`, so an owner id that no longer resolves — a removed
     * account, a stale write — produced a row keyed to that id and LABELLED `Unassigned`, i.e. hours
     * sitting under a member the reader cannot identify. Requiring both the id and the name means such a
     * task lands in the real `Unassigned` group instead, with `id: null`, which is what §4 defines.
     */
    const named = task.ownerId !== null && task.ownerName !== null;
    const key = named ? task.ownerId : UNASSIGNED_LABEL;
    const row = member(
      bucket,
      key as string,
      named ? task.ownerId : null,
      named ? (task.ownerName as string) : UNASSIGNED_LABEL,
    );
    row.hours = add(row.hours, {
      estimateHours: task.estimateHours,
      todoHours: task.todoHours,
      actualHours: task.actualHours,
    });
  }

  const teamRows: TeamCapacityTeamRow[] = [...teams.values()]
    .map((bucket) => {
      const members = [...bucket.members.values()].sort(sortMembers);
      // "Every Team total is the sum of its displayed member rows" — computed FROM the
      // rows, so the table can never fail to add up to its own header.
      const totals = members.reduce((acc, m) => add(acc, m.hours), { ...ZERO });
      return {
        id: bucket.id,
        name: bucket.name,
        archived: bucket.archived,
        totals: round(totals),
        members: members.map((m) => ({ ...m, hours: round(m.hours) })),
      };
    })
    .sort(sortTeams);

  // "All Teams totals are the sum of displayed Team rows" — same guarantee one level up.
  const totals = teamRows.reduce((acc, t) => add(acc, t.totals), { ...ZERO });

  return { totals: round(totals), teams: teamRows };
}

/** `No Team` sorts last; real Teams alphabetically. */
function sortTeams(a: TeamCapacityTeamRow, b: TeamCapacityTeamRow): number {
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return a.name.localeCompare(b.name);
}

/** Unassigned sorts last; real members alphabetically. */
function sortMembers(a: TeamCapacityMemberRow, b: TeamCapacityMemberRow): number {
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return a.name.localeCompare(b.name);
}

/**
 * Is there anything at all to show?
 *
 * "Empty state explains whether there is no capacity and no scoped Task data for the
 * selected Iteration" — the two absences are different problems (nobody planned capacity
 * vs nobody has work), so they are reported separately rather than as one blank table.
 */
export function describeEmptiness(rollup: TeamCapacityRollup): {
  hasCapacity: boolean;
  hasTaskHours: boolean;
} {
  return {
    hasCapacity: rollup.totals.capacityHours > 0,
    hasTaskHours:
      rollup.totals.estimateHours > 0 ||
      rollup.totals.todoHours > 0 ||
      rollup.totals.actualHours > 0,
  };
}
