/**
 * BA business-flow E2E — Notifications page cursor pagination.
 *
 * Verifies the keyset ("seek") paging behind the full Notifications page:
 * bounded pages, a next cursor while more remain, and no overlap across pages.
 * Drives the REAL NotificationsService + repository against the seeded DB.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { buildPageArgs } from '@platform';
import {
  NotificationsService,
  NOTIFICATION_REPOSITORY,
  type INotificationRepository,
} from '@modules/notifications';

import { adminActor, bootRovaApp, WORKSPACE_ID, ADMIN_USER_ID } from './support/flow-harness';

describe('BA flow: notification cursor pagination (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let notifications: NotificationsService;
  let repo: INotificationRepository;
  const actor = adminActor();

  beforeAll(async () => {
    app = await bootRovaApp();
    notifications = app.get(NotificationsService);
    repo = app.get<INotificationRepository>(NOTIFICATION_REPOSITORY);
    // Guarantee ≥ 3 notifications for the admin so two pages of size 2 exist.
    for (let i = 0; i < 3; i++) {
      await repo.create({
        id: uuidv7(),
        workspaceId: WORKSPACE_ID,
        recipientId: ADMIN_USER_ID,
        type: 'work_item',
        title: `Paging fixture ${i}`,
      });
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('pages the feed with a keyset cursor — bounded, with a next cursor and no overlap', async () => {
    const p1 = await notifications.listNotificationsPage(
      actor,
      { unreadOnly: false },
      { limit: 2, cursor: null },
    );
    expect(p1.data.length).toBe(2);
    expect(p1.pageInfo.hasNextPage).toBe(true);
    expect(p1.pageInfo.nextCursor).toBeTruthy();

    const p2 = await notifications.listNotificationsPage(
      actor,
      { unreadOnly: false },
      buildPageArgs({ limit: 2, cursor: p1.pageInfo.nextCursor ?? undefined }),
    );
    expect(p2.data.length).toBeGreaterThanOrEqual(1);

    // Consecutive pages never repeat a row (keyset correctness).
    const ids1 = new Set(p1.data.map((n) => n.id));
    expect(p2.data.some((n) => ids1.has(n.id))).toBe(false);
  });
});
