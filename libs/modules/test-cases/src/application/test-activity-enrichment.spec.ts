import { describe, expect, it } from 'vitest';
import type { ActivityLog } from '@modules/activity';
import { collectTestActivityRefs, enrichTestActivity } from './test-activity-enrichment';

const log = (over: Partial<ActivityLog>): ActivityLog => ({
  id: 'log-1',
  createdAt: '2026-10-16T00:00:00.000Z',
  actorId: 'u-actor',
  actorName: 'Actor',
  entityType: 'test_result',
  entityId: 'tr-1',
  action: 'test_result.updated',
  changes: null,
  metadata: {},
  ...over,
});

const lookups = {
  userNames: new Map([
    ['u-1', 'An'],
    ['u-2', 'Binh'],
  ]),
  resultKeys: new Map([['tr-1', 'TR-4']]),
  testCaseKey: 'TC-9',
};

describe('collectTestActivityRefs', () => {
  it('collects Result ids and every person id, once each', () => {
    const refs = collectTestActivityRefs([
      log({ changes: { field: 'testerId', old: 'u-1', new: 'u-2' } }),
      log({ action: 'test_result.created', metadata: { testerId: 'u-1' } }),
      log({
        entityType: 'test_case',
        entityId: 'tc-1',
        changes: { field: 'name', old: 'a', new: 'b' },
      }),
    ]);
    expect(refs).toEqual({ userIds: ['u-1', 'u-2'], resultIds: ['tr-1'] });
  });
});

describe('enrichTestActivity', () => {
  it('TC-37: a Tester change reads as names, never as the uuids it stores', () => {
    const [row] = enrichTestActivity(
      [log({ changes: { field: 'testerId', old: 'u-1', new: 'u-2' } })],
      lookups,
    );
    expect(row.metadata).toMatchObject({ subjectKey: 'TR-4', oldName: 'An', newName: 'Binh' });
    // The ids stay where they were: the stored value is the reference, the name is display-only.
    expect(row.changes).toEqual({ field: 'testerId', old: 'u-1', new: 'u-2' });
  });

  it('a cleared person field reads as null, not as a missing lookup', () => {
    const [row] = enrichTestActivity(
      [log({ entityType: 'test_case', changes: { field: 'assigneeId', old: 'u-1', new: null } })],
      lookups,
    );
    expect(row.metadata).toMatchObject({ subjectKey: 'TC-9', oldName: 'An', newName: null });
  });

  it('TC-37: a creation row names its Tester', () => {
    const [row] = enrichTestActivity(
      [log({ action: 'test_result.created', metadata: { testerId: 'u-2', verdict: 'pass' } })],
      lookups,
    );
    expect(row.metadata).toMatchObject({ testerName: 'Binh', verdict: 'pass', subjectKey: 'TR-4' });
  });

  it("TC-25: a Test Case row keys by its own metadata first, then by the page's Test Case", () => {
    const rows = enrichTestActivity(
      [
        log({
          entityType: 'test_case',
          action: 'test_case.created',
          metadata: { testCaseKey: 'TC-1' },
        }),
        log({ entityType: 'test_case', action: 'test_case.updated', metadata: null }),
      ],
      lookups,
    );
    expect(rows.map((r) => r.metadata?.subjectKey)).toEqual(['TC-1', 'TC-9']);
  });

  it("falls back to a deleted Result's own recorded key when the lookup has none", () => {
    const [row] = enrichTestActivity(
      [
        log({
          entityId: 'tr-gone',
          action: 'test_result.deleted',
          metadata: { testResultKey: 'TR-2' },
        }),
      ],
      lookups,
    );
    expect(row.metadata?.subjectKey).toBe('TR-2');
  });
});
