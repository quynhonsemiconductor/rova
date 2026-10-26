import { describe, expect, it } from 'vitest';
import { MAX_LIMIT, shapeNotification, shapeNotifications } from './list_notifications';

/**
 * The REAL NotificationResponseDto shape (notifications.controller.ts GET / ->
 * NotificationResponseSchema): a BARE array — body/resourceType/resourceId/readAt NULLABLE,
 * metadata is a record the tool leaves to REST. The route caps by `limit`; the tool fetches
 * one extra row to know when more exist.
 */
const NOTIFICATION_ROW = {
  id: 'n1',
  type: 'WORK_ITEM_ASSIGNED',
  title: 'You were assigned PAY-1',
  body: 'take a look',
  resourceType: 'work_item',
  resourceId: 'w1',
  metadata: { itemKey: 'PAY-1', projectId: 'p1' },
  isRead: false,
  readAt: null,
  actorId: 'u2',
  createdAt: '2026-10-01T00:00:00.000Z',
};

describe('shapeNotifications (NotificationResponseDto[] -> tool payload)', () => {
  it('maps the DTO fields an agent acts on, under the `notifications` list key', () => {
    const out = shapeNotifications([NOTIFICATION_ROW], MAX_LIMIT);
    expect(out.notifications).toEqual([
      {
        id: 'n1',
        type: 'WORK_ITEM_ASSIGNED',
        title: 'You were assigned PAY-1',
        body: 'take a look',
        resourceType: 'work_item',
        resourceId: 'w1',
        isRead: false,
        readAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    expect(out['truncated']).toBeUndefined();
  });

  it('nullable body/readAt stay null', () => {
    const bare = { ...NOTIFICATION_ROW, body: null, readAt: null };
    expect(shapeNotification(bare)).toMatchObject({ body: null, readAt: null });
  });

  it('one extra row beyond the page means truncated', () => {
    const many = Array.from({ length: MAX_LIMIT + 1 }, () => NOTIFICATION_ROW);
    const out = shapeNotifications(many, MAX_LIMIT);
    expect((out.notifications as unknown[]).length).toBe(MAX_LIMIT);
    expect(out).toHaveProperty('truncated', true);
  });
});
