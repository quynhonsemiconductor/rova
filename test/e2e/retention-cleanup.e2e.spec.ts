/**
 * The daily retention sweep, executed against real Postgres.
 *
 * This is a syntax-and-schema gate first: every DELETE joins/subqueries the real table and
 * column names, so a renamed column fails here instead of in production at 01:00 UTC on a
 * table that had been growing unattended. The data assertions cover the two highest-volume
 * tables (audit history and a terminal outbox row) end to end.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CleanupCronService } from '../../apps/worker/src/cron/cleanup.cron';
import * as schema from '../../db/schema';

// Deliberately strict: this spec DELETES rows. It must never run against a shared
// database, and it must never fall back to the migration role/URL.
const url = process.env['TEST_DATABASE_URL'];
if (!url) throw new Error('this spec needs TEST_DATABASE_URL (a dedicated test database)');
const databaseName = new URL(url).pathname.replace(/^\//, '');
if (!databaseName.toLowerCase().includes('test')) {
  throw new Error(`refusing to run retention cleanup against non-test database ${databaseName}`);
}

const auditId = randomUUID();
const outboxId = randomUUID();
const sentEmailId = randomUUID();
const bouncedEmailId = randomUUID();
let pool: Pool;

function service(db: unknown) {
  return new CleanupCronService(
    db as never,
    {
      get: (key: string) =>
        key === 'SESSION_CLEANUP_OLDER_THAN_DAYS' ? 7 : key === 'RETENTION_DRY_RUN' ? false : true,
    } as never,
    { deleteObject: async () => undefined } as never,
    { run: (_name: string, _ttl: number, fn: () => Promise<void>) => fn() } as never,
  );
}

describe('daily retention cleanup (real Postgres)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    const db = drizzle(pool, { schema });
    // One old audit row and one old terminal outbox row. Both are well past retention.
    await db.insert(schema.auditLogs).values({
      id: auditId,
      workspaceId: randomUUID(),
      action: 'retention.test',
      resourceType: 'test',
      resourceId: auditId,
      metadata: {},
      occurredAt: new Date('2020-01-01T00:00:00Z'),
    });
    await db.insert(schema.outboxEvents).values({
      id: outboxId,
      eventId: randomUUID(),
      eventType: 'retention.test',
      aggregateType: 'test',
      aggregateId: randomUUID(),
      workspaceId: randomUUID(),
      payload: {},
      occurredAt: new Date('2020-01-01T00:00:00Z'),
      status: 'published',
      publishedAt: new Date('2020-01-01T00:00:00Z'),
      createdAt: new Date('2020-01-01T00:00:00Z'),
      scheduledAt: new Date('2020-01-01T00:00:00Z'),
    });
    await db.insert(schema.emailOutbox).values([
      {
        id: sentEmailId,
        to: 'retention@qnsc.vn',
        template: 'retention-test',
        status: 'sent',
        sentAt: new Date('2020-01-01T00:00:00Z'),
        createdAt: new Date('2020-01-01T00:00:00Z'),
        scheduledAt: new Date('2020-01-01T00:00:00Z'),
      },
      {
        id: bouncedEmailId,
        to: 'retention-bounce@qnsc.vn',
        template: 'retention-test',
        status: 'bounced',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        scheduledAt: new Date('2020-01-01T00:00:00Z'),
      },
    ]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM audit.audit_logs WHERE id = $1', [auditId]);
    await pool.query('DELETE FROM messaging.outbox_events WHERE id = $1', [outboxId]);
    await pool.query('DELETE FROM messaging.email_outbox WHERE id = ANY($1::uuid[])', [
      [sentEmailId, bouncedEmailId],
    ]);
    await pool.end();
  });

  it('executes every statement and removes rows past retention', async () => {
    const db = drizzle(pool, { schema });
    await service(db).runCleanup();

    const audit = await pool.query('SELECT 1 FROM audit.audit_logs WHERE id = $1', [auditId]);
    const outbox = await pool.query('SELECT 1 FROM messaging.outbox_events WHERE id = $1', [
      outboxId,
    ]);
    const sent = await pool.query('SELECT 1 FROM messaging.email_outbox WHERE id = $1', [
      sentEmailId,
    ]);
    const bounced = await pool.query('SELECT 1 FROM messaging.email_outbox WHERE id = $1', [
      bouncedEmailId,
    ]);
    // Audit and published outbox are the audit trail / re-projection source: never capped.
    expect(audit.rowCount).toBe(1);
    expect(outbox.rowCount).toBe(1);
    // Sent email past retention goes; bounced/complained are read by invitation status.
    expect(sent.rowCount).toBe(0);
    expect(bounced.rowCount).toBe(1);
  });
});
