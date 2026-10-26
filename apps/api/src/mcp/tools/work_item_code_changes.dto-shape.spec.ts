import { describe, expect, it } from 'vitest';
import { MAX_CHANGESETS, MAX_CONNECTIONS, shapeCodeChanges } from './work_item_code_changes';

/**
 * The REAL response shapes, from the producers (scm.controller.ts): BOTH routes answer
 * PagedResult = { data, pageInfo } — cursor-paged, NOT bare arrays (the shape that broke the
 * first draft of this tool). Rows come from toConnectionDto / toChangesetDto.
 */
const CONNECTION_ROW = {
  id: 'c1',
  workItemId: 'w1',
  provider: 'github',
  type: 'pull_request',
  name: 'Fix login #12',
  url: 'https://github.com/o/r/pull/12',
  state: 'open',
  authorName: 'Member One',
  createdAt: '2026-10-01T00:00:00.000Z',
};

const CHANGESET_ROW = {
  id: 'cs1',
  workItemId: 'w1',
  provider: 'github',
  revision: 'abc1234',
  name: 'abc1234',
  message: 'fix: login crash',
  uri: 'https://github.com/o/r/commit/abc1234',
  authorName: 'Member One',
  changes: 3,
  committedAt: '2026-10-01T12:00:00.000Z',
};

describe('shapeCodeChanges (ScmConnection/ScmChangeset pages -> tool payload)', () => {
  it('maps both feeds with the DTO field names', () => {
    const out = shapeCodeChanges([CONNECTION_ROW], false, [CHANGESET_ROW], false);
    expect(out.connections).toEqual([
      {
        id: 'c1',
        provider: 'github',
        type: 'pull_request',
        name: 'Fix login #12',
        url: 'https://github.com/o/r/pull/12',
        state: 'open',
        authorName: 'Member One',
      },
    ]);
    expect(out.changesets).toEqual([
      {
        id: 'cs1',
        provider: 'github',
        revision: 'abc1234',
        name: 'abc1234',
        message: 'fix: login crash',
        uri: 'https://github.com/o/r/commit/abc1234',
        authorName: 'Member One',
        committedAt: '2026-10-01T12:00:00.000Z',
      },
    ]);
    expect(out['truncated']).toBeUndefined();
  });

  it('a nullable committedAt stays null', () => {
    const out = shapeCodeChanges([], false, [{ ...CHANGESET_ROW, committedAt: null }], false);
    expect((out.changesets as Record<string, unknown>[])[0]).toHaveProperty('committedAt', null);
  });

  it('the route saying more exists flags truncated even below the caps', () => {
    expect(shapeCodeChanges([CONNECTION_ROW], true, [], false)).toHaveProperty('truncated', true);
    expect(shapeCodeChanges([], false, [CHANGESET_ROW], true)).toHaveProperty('truncated', true);
  });

  it('rows past the caps are cut and flag truncated', () => {
    const many = Array.from({ length: MAX_CONNECTIONS + 1 }, () => CONNECTION_ROW);
    const out = shapeCodeChanges(many, false, [], false);
    expect((out.connections as unknown[]).length).toBe(MAX_CONNECTIONS);
    expect(out).toHaveProperty('truncated', true);
    const manySets = Array.from({ length: MAX_CHANGESETS + 1 }, () => CHANGESET_ROW);
    const out2 = shapeCodeChanges([], false, manySets, false);
    expect((out2.changesets as unknown[]).length).toBe(MAX_CHANGESETS);
    expect(out2).toHaveProperty('truncated', true);
  });
});
