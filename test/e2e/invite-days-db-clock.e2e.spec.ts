/**
 * The invitation email's "days remaining" is computed on the DATABASE clock.
 *
 * The rule (QNSC architecture, "Time"): the database clock is the only clock for stored data. A value derived
 * from a stored timestamp (here `workspace_invitations.expires_at`) is compared with `now()` inside the same SQL
 * statement, never with a host `Date.now()`.
 *
 * The skew. `vi.setSystemTime` moves the HOST clock only (`toFake: ['Date']`). The database keeps the real time.
 * The invitation is written with `expires_at = now() + 5 days` in SQL, so the database says 5 days remain. The
 * host is then set TWO DAYS AHEAD before the relay runs. On main the relay computes
 * `ceil((expires_at - Date.now()) / 1 day)`, which sees 3 days and mails "3 days". With the fix the SELECT
 * computes the days from the database's now(), so the mail says 5.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DRIZZLE, type DrizzleDB } from '@platform';
import type { EmailSchedulerService } from '@platform/email';
import type { NotificationPubSubService } from '@platform/notifications';
import type { EntraGuestInviteClient } from '@modules/workspace';

import { guestInviteOutbox } from '../../db/schema/messaging';
import { workspaceInvitations } from '../../db/schema/workspace';
import { EntraGuestInviteRelayService } from '../../apps/worker/src/identity/entra-guest-invite-relay.service';
import { ADMIN_USER_ID, WORKSPACE_ID, bootRallyApp } from './support/flow-harness';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

describe('invitation email "days remaining" is computed on the database clock (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('says the database days remaining (5), not the host value (3), when the host clock is 2 days ahead', async () => {
    const email = `dana-${randomUUID()}@partner.example`;
    const rawToken = `raw-${randomUUID()}`;

    // Expires 5 days from DATABASE now(). Written in SQL so the database clock is the one that decides it.
    const [invitation] = await db
      .insert(workspaceInvitations)
      .values({
        workspaceId: WORKSPACE_ID,
        email,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        invitedBy: ADMIN_USER_ID,
        expiresAt: sql`now() + interval '5 days'`,
      })
      .returning();

    await db.insert(guestInviteOutbox).values({
      invitationId: invitation.id,
      workspaceId: WORKSPACE_ID,
      email,
      inviteToken: rawToken,
    });

    const schedule = vi.fn().mockResolvedValue(undefined);
    const client = {
      invite: vi.fn().mockResolvedValue({ outcome: 'invited', guestObjectId: null }),
    } as unknown as EntraGuestInviteClient;
    const relay = new EntraGuestInviteRelayService(
      db,
      client,
      { get: () => 'https://rova.example' } as never,
      { schedule } as unknown as EmailSchedulerService,
      { subscribeGuestInviteRelayWake: vi.fn() } as unknown as NotificationPubSubService,
    );

    // Host clock two days AHEAD of the database. Only Date moves.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + TWO_DAYS_MS);

    await relay.relay();

    const ours = schedule.mock.calls
      .map(([options]) => options as { to: string; vars: { expiresInDays: string } })
      .find((options) => options.to === email);
    expect(ours, 'the invitation email was scheduled').toBeDefined();
    expect(ours?.vars.expiresInDays).toBe('5');
  });
});
