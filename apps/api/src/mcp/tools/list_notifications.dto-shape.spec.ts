import { describe, expect, it } from 'vitest';
import { NotificationResponseSchema } from '@modules/notifications/interface/http/dto/notification-response.dto';
import { listResult } from './rest';
import { shapeNotification } from './list_notifications';

/**
 * `rova_list_notifications` relays GET /v1/notifications/paged: a PAGE of
 * NotificationResponseSchema rows ({ data, pageInfo }). The fixture parses through the REAL
 * schema; pageInfo is the platform's plain PageInfo interface (no zod schema exists for it —
 * pinned by hand, like the schema-drift convention).
 */
const PAGE_BODY = {
  data: [
    NotificationResponseSchema.parse({
      id: '0194a000-0000-7000-8000-000000000001',
      type: 'WORK_ITEM_ASSIGNED',
      title: 'You were assigned US-1',
      body: 'take a look',
      resourceType: 'work_item',
      resourceId: '0194a000-0000-7000-8000-000000000002',
      metadata: { itemKey: 'US-1', projectId: '0194a000-0000-7000-8000-000000000003' },
      isRead: false,
      readAt: null,
      actorId: '0194a000-0000-7000-8000-000000000004',
      createdAt: '2026-06-20T08:00:00.000Z',
    }),
  ],
  pageInfo: { nextCursor: null, hasNextPage: false },
};

const ERROR_BODY = { statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' };

describe('shapeNotification + listResult (paged NotificationResponseDto -> tool payload)', () => {
  it('maps the DTO fields an agent acts on, under the `notifications` list key', () => {
    const out = listResult(200, PAGE_BODY, shapeNotification, 'notifications');
    const body = JSON.parse(out.content[0].text);
    expect(body.notifications).toEqual([
      {
        id: PAGE_BODY.data[0].id,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'You were assigned US-1',
        body: 'take a look',
        resourceType: 'work_item',
        resourceId: PAGE_BODY.data[0].resourceId,
        isRead: false,
        readAt: null,
        createdAt: '2026-06-20T08:00:00.000Z',
      },
    ]);
    // the route's own pageInfo is relayed untouched
    expect(body.pageInfo).toEqual({ nextCursor: null, hasNextPage: false });
  });

  it('nullable body/readAt stay null', () => {
    const bare = NotificationResponseSchema.parse({
      ...PAGE_BODY.data[0],
      body: null,
      readAt: null,
      resourceType: null,
      resourceId: null,
    });
    expect(shapeNotification(bare)).toMatchObject({ body: null, readAt: null });
  });

  it('a denial relays the route status as isError', () => {
    const out = listResult(401, ERROR_BODY, shapeNotification, 'notifications');
    expect('isError' in out && out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ statusCode: 401, error: ERROR_BODY });
  });
});
