/**
 * Story / Task lifecycle dates (Phase 7 Carryover, CO-01 / CO-02, migration 0132).
 *
 * The rules live in two BEFORE triggers and one backfill function, so this spec drives them with raw
 * SQL — the same way a seed or a manual correction would reach the table. If the floor only held for
 * writes that go through the service, it would not be a floor.
 *
 * Every fixture row is keyed `LD-…` and removed in `afterAll`: Stories left in the seeded NXP project
 * break other specs' "every option is a `US-` key" assertions (see accepted-date-backfill's note).
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';

import { pgOptions } from '../../db/pg-ssl';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { IterationStatusService } from '@modules/iterations';

import {
  ADMIN_USER_ID,
  ALL,
  SEEDED,
  WORKSPACE_ID,
  adminActor,
  bootRallyApp,
  uniqueKey,
} from './support/flow-harness';

// A type alias, not an interface: `db.execute<T>` requires `T extends Record<string, unknown>`, which
// an interface (no implicit index signature) does not satisfy.
type DateRow = {
  start_date: string | null;
  actual_end_date: string | null;
};

describe('lifecycle dates (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let seededTimeZone: string | undefined;

  /**
   * Write a PRE-MIGRATION row shape: `start_date`/`actual_end_date` NULL on a row already in the
   * state. Only possible with the stamping trigger disabled, and `ALTER TABLE … DISABLE TRIGGER`
   * needs the table OWNER — CI connects the app as a non-owner role (`must be owner of table`), so
   * this runs on the migration connection, exactly as a manual correction would. One transaction,
   * so the trigger can never be left disabled for a concurrent writer.
   */
  async function asOwnerWithoutTrigger(
    table: 'work_items' | 'tasks',
    trigger: string,
    statement: string,
    params: unknown[],
  ): Promise<void> {
    const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error('needs DATABASE_MIGRATION_URL or DATABASE_URL');
    const pool = new Pool(pgOptions(url));
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`alter table work.${table} disable trigger ${trigger}`);
      await client.query(statement, params);
      await client.query(`alter table work.${table} enable trigger ${trigger}`);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  }

  async function today(): Promise<string> {
    const rows = await db.execute<{ d: string }>(
      sql`select work.workspace_local_date(${WORKSPACE_ID}::uuid, now())::text as d`,
    );
    return rows.rows[0].d;
  }

  async function story(state = 'defined', type: 'story' | 'defect' = 'story'): Promise<string> {
    const key = `LD-${uniqueKey()}`;
    const rows = await db.execute<{ id: string }>(sql`
      insert into work.work_items
        (workspace_id, project_id, item_key, type, title, schedule_state, flow_state,
         status_id, created_by, rank, iteration_id)
      select ${WORKSPACE_ID}::uuid, ${SEEDED.nxp.projectId}::uuid, ${key}, ${type}::work_item_type,
             ${`Lifecycle ${key}`}, ${state}::work_item_schedule_state,
             ${state}::work_item_schedule_state,
             (select id from work.workflow_statuses where project_id = ${SEEDED.nxp.projectId}::uuid limit 1),
             ${ADMIN_USER_ID}::uuid, ${`z${key}:`}, ${SEEDED.nxp.iterationCurrentId}::uuid
      returning id
    `);
    return rows.rows[0].id;
  }

  async function task(parentId: string, state = 'defined'): Promise<string> {
    const key = `LD-${uniqueKey()}`;
    const rows = await db.execute<{ id: string }>(sql`
      insert into work.tasks
        (workspace_id, project_id, parent_id, item_key, title, state, created_by, rank)
      values (${WORKSPACE_ID}::uuid, ${SEEDED.nxp.projectId}::uuid, ${parentId}::uuid, ${key},
              ${`Lifecycle task ${key}`}, ${state}::work.task_state, ${ADMIN_USER_ID}::uuid, ${`z${key}:`})
      returning id
    `);
    return rows.rows[0].id;
  }

  async function storyDates(id: string): Promise<DateRow> {
    const rows = await db.execute<DateRow>(sql`
      select start_date::text, actual_end_date::text from work.work_items where id = ${id}::uuid`);
    return rows.rows[0];
  }

  async function taskDates(id: string): Promise<DateRow> {
    const rows = await db.execute<DateRow>(sql`
      select start_date::text, actual_end_date::text from work.tasks where id = ${id}::uuid`);
    return rows.rows[0];
  }

  const setStoryState = (id: string, state: string) =>
    db.execute(sql`update work.work_items
                      set schedule_state = ${state}::work_item_schedule_state,
                          flow_state = ${state}::work_item_schedule_state
                    where id = ${id}::uuid`);

  const setTaskState = (id: string, state: string) =>
    // `task_state` lives in the `work` schema (unlike the work-item enums, which are in `public`).
    db.execute(sql`update work.tasks set state = ${state}::work.task_state where id = ${id}::uuid`);

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    const tz = await db.execute<{ timezone: string }>(
      sql`select timezone from workspace.workspace_settings where workspace_id = ${WORKSPACE_ID}::uuid`,
    );
    seededTimeZone = tz.rows[0]?.timezone;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`delete from work.activity_logs where entity_id in (
        select id from work.work_items where item_key like 'LD-%'
        union all select id from work.tasks where item_key like 'LD-%')`);
      await db.execute(sql`delete from work.tasks where item_key like 'LD-%'`);
      await db.execute(sql`delete from work.work_items where item_key like 'LD-%'`);
      if (seededTimeZone !== undefined) {
        await db.execute(sql`update workspace.workspace_settings set timezone = ${seededTimeZone}
                              where workspace_id = ${WORKSPACE_ID}::uuid`);
      }
    }
    await app?.close();
  });

  describe('Story (CO-01)', () => {
    it('is blank before the triggering transitions (AC5)', async () => {
      const id = await story();
      expect(await storyDates(id)).toEqual({ start_date: null, actual_end_date: null });
    });

    it('stamps Start Date on the first entry into In-Progress and keeps it (AC1/AC2)', async () => {
      const id = await story();
      await setStoryState(id, 'in_progress');
      const stamped = (await storyDates(id)).start_date;
      expect(stamped).toBe(await today());

      // Later state changes, a reopen, and an Iteration change do not rewrite it.
      await setStoryState(id, 'completed');
      await setStoryState(id, 'defined');
      await setStoryState(id, 'in_progress');
      await db.execute(sql`update work.work_items set iteration_id = ${SEEDED.nxp.iterationFutureId}::uuid
                            where id = ${id}::uuid`);
      expect((await storyDates(id)).start_date).toBe(stamped);
    });

    it('stamps Actual End Date on the first entry into Accepted and keeps it through a reopen (AC3/AC4)', async () => {
      const id = await story('in_progress');
      await setStoryState(id, 'accepted');
      const first = (await storyDates(id)).actual_end_date;
      expect(first).toBe(await today());

      await setStoryState(id, 'in_progress');
      expect((await storyDates(id)).actual_end_date, 'a reopen must not clear it').toBe(first);
      await setStoryState(id, 'accepted');
      expect((await storyDates(id)).actual_end_date).toBe(first);
    });

    it('leaves Actual End Date blank for a Story moved straight to Release (ruling R2)', async () => {
      const id = await story('in_progress');
      await setStoryState(id, 'release');
      expect((await storyDates(id)).actual_end_date).toBeNull();
    });

    it('never stamps a Defect (plan D12)', async () => {
      const id = await story('defined', 'defect');
      await setStoryState(id, 'in_progress');
      await setStoryState(id, 'accepted');
      expect(await storyDates(id)).toEqual({ start_date: null, actual_end_date: null });
    });

    it('does not stamp an edit to a Story that was already In-Progress (no guessed date)', async () => {
      const id = await story('in_progress');
      // Simulate a pre-migration row: in progress, never dated.
      await asOwnerWithoutTrigger(
        'work_items',
        'trg_stamp_story_lifecycle_dates',
        'update work.work_items set start_date = null where id = $1::uuid',
        [id],
      );
      await db.execute(sql`update work.work_items set title = 'edited' where id = ${id}::uuid`);
      expect((await storyDates(id)).start_date).toBeNull();
    });

    it('refuses a direct write that would overwrite or clear a set date (CO-BR-10)', async () => {
      const id = await story();
      await setStoryState(id, 'in_progress');
      await setStoryState(id, 'accepted');
      const before = await storyDates(id);
      await db.execute(sql`update work.work_items set start_date = '2000-01-01', actual_end_date = null
                            where id = ${id}::uuid`);
      expect(await storyDates(id)).toEqual(before);
    });
  });

  describe('Task (CO-02)', () => {
    it('stamps Start Date and Actual End Date once and keeps them (AC1–AC4)', async () => {
      const parent = await story();
      const id = await task(parent);
      expect(await taskDates(id)).toEqual({ start_date: null, actual_end_date: null });

      await setTaskState(id, 'in_progress');
      await setTaskState(id, 'completed');
      const stamped = await taskDates(id);
      expect(stamped).toEqual({ start_date: await today(), actual_end_date: await today() });

      // Reopen, complete again, and follow the parent into another Iteration.
      await setTaskState(id, 'in_progress');
      await setTaskState(id, 'completed');
      await db.execute(sql`update work.work_items set iteration_id = ${SEEDED.nxp.iterationFutureId}::uuid
                            where id = ${parent}::uuid`);
      expect(await taskDates(id)).toEqual(stamped);

      await db.execute(sql`update work.tasks set start_date = '2000-01-01', actual_end_date = null
                            where id = ${id}::uuid`);
      expect(await taskDates(id)).toEqual(stamped);
    });
  });

  describe('read surfaces (CO-01 / CO-02 AC5)', () => {
    it('reports the same persisted dates on the record, the Task list and Iteration Status', async () => {
      const workItems = app.get(WorkItemsService);
      const iterationStatus = app.get(IterationStatusService);
      const actor = adminActor();
      const parent = await story();
      const id = await task(parent);

      // Through the SERVICE this time, the way the Task list's state cell writes it.
      await workItems.updateWorkItem(actor, id, { scheduleState: 'in_progress' });
      await workItems.updateWorkItem(actor, id, { scheduleState: 'completed' });
      await workItems.updateWorkItem(actor, parent, { scheduleState: 'in_progress' });
      const expected = await today();

      const detail = (await workItems.getWorkItemDetail(actor, id)).item;
      const list = await workItems.listTasks(actor, parent);
      const row = list.find((t) => t.id === id);
      expect(detail.startDate).toBe(expected);
      expect(detail.actualEndDate).toBe(expected);
      expect(row?.startDate).toBe(detail.startDate);
      expect(row?.actualEndDate).toBe(detail.actualEndDate);

      const status = await iterationStatus.getStatus(
        actor,
        SEEDED.nxp.iterationCurrentId,
        { startDate: expected },
        ALL,
      );
      const storyRow = status.items.data.find((i) => i.id === parent);
      expect(storyRow?.startDate).toBe(expected);
      expect(storyRow?.targetEndDate).toBeNull();
      // The text filter is a real predicate: a date nothing carries finds nothing of ours.
      const none = await iterationStatus.getStatus(
        actor,
        SEEDED.nxp.iterationCurrentId,
        { startDate: '1999-' },
        ALL,
      );
      expect(none.items.data.some((i) => i.id === parent)).toBe(false);
    });
  });

  it('dates "today" in the WORKSPACE time zone', async () => {
    // UTC+14 and UTC-11 disagree about the calendar date for most of every day; whichever one is
    // set, the stamp must equal that zone's date.
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      await db.execute(sql`update workspace.workspace_settings set timezone = ${zone}
                            where workspace_id = ${WORKSPACE_ID}::uuid`);
      const expected = await db.execute<{ d: string }>(
        sql`select (now() at time zone ${zone})::date::text as d`,
      );
      const id = await story();
      await setStoryState(id, 'in_progress');
      expect((await storyDates(id)).start_date).toBe(expected.rows[0].d);
    }
  });

  describe('backfill (ruling R5)', () => {
    async function logState(
      entityType: 'work_item' | 'task',
      entityId: string,
      to: string,
      at: string,
    ): Promise<void> {
      await db.execute(sql`
        insert into work.activity_logs
          (workspace_id, project_id, entity_type, entity_id, action, changes, created_at)
        values (${WORKSPACE_ID}::uuid, ${SEEDED.nxp.projectId}::uuid,
                ${entityType}::activity_entity_type, ${entityId}::uuid,
                ${entityType === 'task' ? 'task.state_changed' : 'work_item.schedule_state_changed'},
                ${JSON.stringify({ field: 'scheduleState', old: 'defined', new: to })}::jsonb,
                ${at}::timestamptz)`);
    }

    /** A row in the pre-migration shape: in a state, but undated. */
    async function undate(table: 'work_items' | 'tasks', id: string): Promise<void> {
      const trigger =
        table === 'tasks' ? 'trg_stamp_task_lifecycle_dates' : 'trg_stamp_story_lifecycle_dates';
      await asOwnerWithoutTrigger(
        table,
        trigger,
        `update work.${table} set start_date = null, actual_end_date = null where id = $1::uuid`,
        [id],
      );
    }

    it('dates from the FIRST logged transition, workspace-local, and leaves rows without history blank', async () => {
      await db.execute(sql`update workspace.workspace_settings set timezone = 'Asia/Ho_Chi_Minh'
                            where workspace_id = ${WORKSPACE_ID}::uuid`);
      const withHistory = await story('accepted');
      const withoutHistory = await story('accepted');
      const parent = await story();
      const taskWithHistory = await task(parent, 'completed');
      await undate('work_items', withHistory);
      await undate('work_items', withoutHistory);
      await undate('tasks', taskWithHistory);

      // 2026-06-10T18:30Z is already 2026-06-11 in Ho Chi Minh (UTC+7).
      await logState('work_item', withHistory, 'in_progress', '2026-06-10T18:30:00Z');
      await logState('work_item', withHistory, 'accepted', '2026-06-12T09:00:00Z');
      await logState('work_item', withHistory, 'in_progress', '2026-06-14T09:00:00Z');
      await logState('work_item', withHistory, 'accepted', '2026-06-20T09:00:00Z');
      await logState('task', taskWithHistory, 'in_progress', '2026-06-11T02:00:00Z');
      await logState('task', taskWithHistory, 'completed', '2026-06-13T02:00:00Z');
      await logState('task', taskWithHistory, 'in_progress', '2026-06-15T02:00:00Z');

      await db.execute(sql`select work.backfill_lifecycle_dates()`);

      expect(await storyDates(withHistory)).toEqual({
        start_date: '2026-06-11',
        actual_end_date: '2026-06-12',
      });
      expect(await taskDates(taskWithHistory)).toEqual({
        start_date: '2026-06-11',
        actual_end_date: '2026-06-13',
      });
      expect(await storyDates(withoutHistory)).toEqual({ start_date: null, actual_end_date: null });
    });

    it('never overwrites a date that is already set', async () => {
      const id = await story();
      await setStoryState(id, 'in_progress');
      const stamped = (await storyDates(id)).start_date;
      await logState('work_item', id, 'in_progress', '2020-01-01T00:00:00Z');
      await db.execute(sql`select work.backfill_lifecycle_dates()`);
      expect((await storyDates(id)).start_date).toBe(stamped);
    });
  });
});
