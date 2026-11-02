import { describe, expect, it } from 'vitest';
import {
  ScmChangesetResponseSchema,
  ScmConnectionResponseSchema,
} from '@modules/scm/interface/http/dto/scm-response.dto';
import { shapeCodeChanges } from './work_item_code_changes';

/**
 * `rova_work_item_code_changes` composes TWO producer shapes: BOTH routes answer a PAGE
 * ({ data, pageInfo }) — cursor-paged, NOT bare arrays (the shape that broke the first draft).
 * Fixtures parse through the REAL ScmConnectionResponseSchema / ScmChangesetResponseSchema.
 */
const CONNECTION_ROW = ScmConnectionResponseSchema.parse({
  id: '0194a000-0000-7000-8000-000000000001',
  workItemId: '0194a000-0000-7000-8000-000000000002',
  provider: 'github',
  type: 'pull_request',
  name: 'feat(nx): upgrade the workspace to Nx v21 (#4821)',
  url: 'https://github.com/o/r/pull/4821',
  state: 'open',
  authorName: 'Member One',
  createdAt: '2026-06-20T08:00:00.000Z',
});

const CHANGESET_ROW = ScmChangesetResponseSchema.parse({
  id: '0194a000-0000-7000-8000-000000000003',
  workItemId: '0194a000-0000-7000-8000-000000000002',
  provider: 'github',
  revision: '9f2c1ab',
  name: 'feat(nx): bump workspace to v21',
  message: 'feat(nx): bump workspace to v21',
  uri: 'https://github.com/o/r/commit/9f2c1ab',
  authorName: 'Member One',
  changes: [{ action: 'M', path: 'workspace.json' }],
  committedAt: '2026-06-24T11:02:00.000Z',
});

describe('shapeCodeChanges (ScmConnection/ScmChangeset pages -> tool payload)', () => {
  it('maps both feeds with the DTO field names', () => {
    const out = shapeCodeChanges([CONNECTION_ROW], false, [CHANGESET_ROW], false);
    expect(out.connections).toEqual([
      {
        id: CONNECTION_ROW.id,
        provider: 'github',
        type: 'pull_request',
        name: CONNECTION_ROW.name,
        url: CONNECTION_ROW.url,
        state: 'open',
        authorName: 'Member One',
      },
    ]);
    expect(out.changesets).toEqual([
      {
        id: CHANGESET_ROW.id,
        provider: 'github',
        revision: '9f2c1ab',
        name: CHANGESET_ROW.name,
        message: CHANGESET_ROW.message,
        uri: CHANGESET_ROW.uri,
        authorName: 'Member One',
        committedAt: '2026-06-24T11:02:00.000Z',
      },
    ]);
    expect(out['truncated']).toBeUndefined();
  });

  it('a nullable committedAt stays null', () => {
    const out = shapeCodeChanges([], false, [{ ...CHANGESET_ROW, committedAt: null }], false);
    expect((out.changesets as Record<string, unknown>[])[0]).toHaveProperty('committedAt', null);
  });

  it('truncated comes ONLY from the route pages (hasNextPage), never a length guess', () => {
    // at the cap but no next page: the route returned everything there was
    expect(shapeCodeChanges([CONNECTION_ROW], false, [CHANGESET_ROW], false)).not.toHaveProperty(
      'truncated',
    );
    expect(shapeCodeChanges([], true, [], false)).toHaveProperty('truncated', true);
    expect(shapeCodeChanges([], false, [], true)).toHaveProperty('truncated', true);
  });
});
