import { describe, expect, it } from 'vitest';
import { shapeComments } from './list_comments';

/**
 * The REAL CommentResponseDto shape (collaboration.controller.ts GET comments ->
 * CommentResponseSchema): parentId NULLABLE, editedAt NULLABLE (an edited comment has
 * isEdited + editedAt), createdAt/updatedAt datetimes. The extension adds parentId and
 * editedAt to what the tool relays.
 */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c1',
    entityType: 'work_item',
    entityId: 'w1',
    authorId: 'u2',
    parentId: null,
    body: 'first',
    isEdited: false,
    editedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('shapeComments (CommentResponseDto[] -> tool payload)', () => {
  it('sorts newest-first and maps the extended fields', () => {
    const out = shapeComments([
      row({ id: 'c1', createdAt: '2026-10-01T00:00:00.000Z' }),
      row({
        id: 'c2',
        parentId: 'c1',
        body: 'edited text',
        isEdited: true,
        editedAt: '2026-10-02T00:00:00.000Z',
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    ]);
    expect(out.truncated).toBe(false);
    expect(out.comments.map((c) => (c as { id: string }).id)).toEqual(['c2', 'c1']);
    const edited = out.comments[0] as Record<string, unknown>;
    expect(edited).toMatchObject({
      parentId: 'c1',
      isEdited: true,
      editedAt: '2026-10-02T00:00:00.000Z',
    });
    expect((out.comments[1] as Record<string, unknown>).parentId).toBeNull();
  });

  it('an over-long body is truncated with an ellipsis and flags the payload', () => {
    const out = shapeComments([row({ body: 'x'.repeat(4_001) })]);
    expect(out.truncated).toBe(true);
    expect((out.comments[0] as { body: string }).body.endsWith('…')).toBe(true);
  });
});
