import { describe, expect, it } from 'vitest';
import { CommentResponseSchema } from '@modules/collaboration/interface/http/dto/collaboration-response.dto';
import { shapeComments } from './list_comments';

/**
 * `rova_list_comments` relays CommentResponseSchema rows (GET /v1/work-items/:id/comments) —
 * parentId NULLABLE, editedAt NULLABLE (an edited comment has isEdited + editedAt). The
 * fixtures parse through the REAL schema.
 */
function row(over: Partial<Record<string, unknown>> = {}) {
  return CommentResponseSchema.parse({
    id: '0194a000-0000-7000-8000-000000000001',
    entityType: 'work_item',
    entityId: '0194a000-0000-7000-8000-000000000002',
    authorId: '0194a000-0000-7000-8000-000000000003',
    parentId: null,
    body: 'first',
    isEdited: false,
    editedAt: null,
    createdAt: '2026-06-20T08:00:00.000Z',
    updatedAt: '2026-06-20T08:00:00.000Z',
    ...over,
  });
}

describe('shapeComments (CommentResponseDto[] -> tool payload)', () => {
  it('sorts newest-first and maps the extended fields', () => {
    const out = shapeComments([
      row({ id: '0194a000-0000-7000-8000-000000000001' }),
      row({
        id: '0194a000-0000-7000-8000-000000000004',
        parentId: '0194a000-0000-7000-8000-000000000001',
        body: 'edited text',
        isEdited: true,
        editedAt: '2026-06-21T08:00:00.000Z',
        createdAt: '2026-06-21T08:00:00.000Z',
        updatedAt: '2026-06-21T08:00:00.000Z',
      }),
    ]);
    expect(out.truncated).toBe(false);
    expect(out.comments.map((c) => (c as { id: string }).id)).toEqual([
      '0194a000-0000-7000-8000-000000000004',
      '0194a000-0000-7000-8000-000000000001',
    ]);
    const edited = out.comments[0] as Record<string, unknown>;
    expect(edited).toMatchObject({
      parentId: '0194a000-0000-7000-8000-000000000001',
      isEdited: true,
      editedAt: '2026-06-21T08:00:00.000Z',
    });
    expect((out.comments[1] as Record<string, unknown>).parentId).toBeNull();
  });

  it('an over-long body is truncated with an ellipsis and flags the payload', () => {
    const out = shapeComments([row({ body: 'x'.repeat(4_001) })]);
    expect(out.truncated).toBe(true);
    expect((out.comments[0] as { body: string }).body.endsWith('…')).toBe(true);
  });
});
