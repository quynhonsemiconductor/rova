/**
 * A notification scheduled without an explicit time is stamped on the DATABASE clock.
 *
 * The rule (QNSC architecture, "Time"): the database clock is the only clock for stored data. A timestamp
 * column is filled by the database (its column default, `now()`), never by a host `new Date()` passed into
 * the insert.
 *
 * The skew. `vi.setSystemTime` moves the HOST clock only (`toFake: ['Date']`). The database keeps the real
 * time. The host is set one hour AHEAD before the schedule call. On main, `NotificationSchedulerService`
 * writes `scheduled_at = scheduledAt ?? new Date()`, so the stored row lands an hour in the future of the
 * database and this test fails. With the fallback removed, the column default `now()` applies and the row
 * lands within minutes of the database's own now().
 */
import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DRIZZLE, type DrizzleDB } from '@platform';
import { NotificationSchedulerService } from '@platform/notifications';

import { notificationOutbox } from '../../db/schema/messaging';
import { WORKSPACE_ID, adminActor, bootRallyApp, uniqueKey } from './support/flow-harness';

const HOUR_MS = 60 * 60 * 1000;
/** Generous: the database and the test runner share a machine; the stamp only has to be near the DB clock. */
const DB_NEAR_SECONDS = 300;

describe('notification scheduled_at is stamped on the database clock (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  let scheduler: NotificationSchedulerService;

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    scheduler = app.get(NotificationSchedulerService, { strict: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a notification scheduled with no explicit time gets the database clock, not a host clock 1 hour ahead', async () => {
    const recipientId = randomUUID();
    const idempotencyKey = `db-clock-${uniqueKey('N')}`;

    // Host ONE HOUR AHEAD of the database. Only Date moves; the database is untouched.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + HOUR_MS);

    await scheduler.schedule({
      workspaceId: WORKSPACE_ID,
      recipientId,
      actorId: adminActor().sub,
      template: 'WORK_ITEM_ASSIGNED',
      vars: { itemKey: 'NXP-DBCLOCK', itemTitle: 'db clock', projectId: randomUUID() },
      resourceId: randomUUID(),
      idempotencyKey,
    });

    const [row] = await db
      .select({
        scheduledAt: notificationOutbox.scheduledAt,
        // Seconds from the DATABASE's now() to the stored instant. Near zero when the DB stamped it.
        lagSeconds: sql<number>`extract(epoch from (${notificationOutbox.scheduledAt} - now()))`,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.idempotencyKey, idempotencyKey))
      .limit(1);

    expect(row, 'the scheduled row was written').toBeDefined();
    expect(Math.abs(Number(row?.lagSeconds))).toBeLessThan(DB_NEAR_SECONDS);
  });
});
