import type { ActivityLog } from '@modules/activity';

/**
 * Revision History for a Test Case / Test Result is read through this ONE projection (US-93 TC-25,
 * US-97 TC-37). The activity log stores ids — the stable reference — and this adds the display
 * values the reader needs beside them, in `metadata`, so the response contract does not change:
 *
 *   • `subjectKey` — the TC-/TR- key of the row's OWN record. A Test Case's history also returns its
 *     Results' rows (`context_id`), so "which record" is a per-row fact, not the page's.
 *   • `oldName` / `newName` — on a person field change. The diff records `ownerId`/`assigneeId`/
 *     `testerId` as uuids, and a uuid is not something a reader can review (TC-37).
 *   • `testerName` — on `test_result.created`, whose sentence names the Tester.
 *
 * Resolved on READ, like `actorName` beside it, and that is deliberate: rows written before this
 * existed carry only ids, and a write-time snapshot would have left every one of them a uuid.
 */
export const TEST_ACTIVITY_PERSON_FIELDS: ReadonlySet<string> = new Set([
  'ownerId',
  'assigneeId',
  'testerId',
]);

export interface TestActivityLookups {
  /** user id → display name (`coalesce(display_name, email)`). */
  userNames: ReadonlyMap<string, string>;
  /** test result id → `TR-<n>`, deleted Results included (their history outlives them). */
  resultKeys: ReadonlyMap<string, string>;
  /** The Test Case key for rows whose subject is a Test Case. */
  testCaseKey: string | null;
}

const asId = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The ids {@link enrichTestActivity} will need resolved, so the caller can fetch them in one go. */
export function collectTestActivityRefs(logs: ActivityLog[]): {
  userIds: string[];
  resultIds: string[];
} {
  const userIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const log of logs) {
    if (log.entityType === 'test_result') resultIds.add(log.entityId);
    if (log.changes && TEST_ACTIVITY_PERSON_FIELDS.has(log.changes.field)) {
      const oldId = asId(log.changes.old);
      const newId = asId(log.changes.new);
      if (oldId) userIds.add(oldId);
      if (newId) userIds.add(newId);
    }
    const testerId = asId(log.metadata?.testerId);
    if (log.action === 'test_result.created' && testerId) userIds.add(testerId);
  }
  return { userIds: [...userIds], resultIds: [...resultIds] };
}

export function enrichTestActivity(
  logs: ActivityLog[],
  lookups: TestActivityLookups,
): ActivityLog[] {
  const name = (value: unknown) => {
    const id = asId(value);
    return id ? (lookups.userNames.get(id) ?? null) : null;
  };
  return logs.map((log) => {
    const metadata: Record<string, unknown> = { ...(log.metadata ?? {}) };
    const subjectKey =
      log.entityType === 'test_result'
        ? (lookups.resultKeys.get(log.entityId) ?? asId(metadata.testResultKey))
        : (asId(metadata.testCaseKey) ?? lookups.testCaseKey);
    if (subjectKey) metadata.subjectKey = subjectKey;

    if (log.changes && TEST_ACTIVITY_PERSON_FIELDS.has(log.changes.field)) {
      metadata.oldName = name(log.changes.old);
      metadata.newName = name(log.changes.new);
    }
    if (log.action === 'test_result.created') metadata.testerName = name(metadata.testerId);
    return { ...log, metadata };
  });
}
