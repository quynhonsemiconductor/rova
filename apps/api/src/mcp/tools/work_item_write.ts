import { denied, result, versionFromEtag, type McpRestResult } from './rest';

/**
 * The ONE shape a work-item write returns: the fields a model chains on, plus `version` — the
 * concurrency token every later `rova_update_work_item` derives its `If-Match` from. `changed`
 * names the fields this call sent, so a caller can tell a no-op from a real edit without diffing.
 *
 * Not `shapeWorkItem` (get_work_item.ts): that one resolves ids through the reference feeds for
 * DISPLAY. A write answers the row it just changed; the ids are what the model needs, and a
 * second round of feed reads would make every write depend on pickers it does not touch.
 */
export function workItemWriteResult(
  res: McpRestResult,
  changed: string[],
): ReturnType<typeof result> | ReturnType<typeof denied> {
  if (res.statusCode >= 400 || res.json === null || typeof res.json !== 'object') {
    return denied(res.statusCode, res.json);
  }
  const row = res.json as Record<string, unknown>;
  const version = versionFromEtag(res);
  return result(res.statusCode, res.json, {
    workItem: shapeWrittenWorkItem(row),
    version: version ?? null,
    changed,
  });
}

/** The compact write shape; exported so the 412 path shares it with a fresh read. */
export function shapeWrittenWorkItem(row: Record<string, unknown>) {
  return {
    id: row['id'],
    itemKey: row['itemKey'],
    type: row['type'],
    title: row['title'],
    projectId: row['projectId'],
    statusId: row['statusId'],
    scheduleState: row['scheduleState'],
    priority: row['priority'],
    assignee: { id: row['assigneeId'] ?? null, name: row['assigneeName'] ?? null },
    devOwner: { id: row['devOwnerId'] ?? null, name: row['devOwnerName'] ?? null },
    teamId: row['teamId'] ?? null,
    iterationId: row['iterationId'] ?? null,
    releaseId: row['releaseId'] ?? null,
    featureId: row['featureId'] ?? null,
    parentId: row['parentId'] ?? null,
    storyPoints: row['storyPoints'] ?? null,
    estimateHours: row['estimateHours'] ?? null,
    todoHours: row['todoHours'] ?? null,
    actualHours: row['actualHours'] ?? null,
    isBlocked: row['isBlocked'],
    blockedReason: row['blockedReason'] ?? null,
    acceptanceCriteria: row['acceptanceCriteria'] ?? null,
    severity: row['severity'] ?? null,
    foundInEnvironment: row['foundInEnvironment'] ?? null,
    foundInReleaseId: row['foundInReleaseId'] ?? null,
    rootCause: row['rootCause'] ?? null,
    resolution: row['resolution'] ?? null,
    defectState: row['defectState'] ?? null,
    fixedInBuild: row['fixedInBuild'] ?? null,
    startDate: row['startDate'] ?? null,
    targetEndDate: row['targetEndDate'] ?? null,
    updatedAt: row['updatedAt'],
  };
}

/**
 * The 412 answer the update tool returns when the write lost the version race: the REST refusal
 * UNCHANGED plus the item as it stands now (with its new `version`). The model can re-apply its
 * intent without a second read, and nothing in the payload is a value it did not already see —
 * the fresh row is the same shape the read tools answer.
 */
export function staleWorkItemResult(stale: McpRestResult, fresh: McpRestResult) {
  const body = fresh.json as Record<string, unknown> | null;
  const row =
    fresh.statusCode < 400 && body && typeof body === 'object'
      ? ((body['item'] as Record<string, unknown> | undefined) ?? body)
      : null;
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          statusCode: 412,
          error: stale.json,
          current: row ? shapeWrittenWorkItem(row) : null,
          version: row ? (versionFromEtag(fresh) ?? null) : null,
        }),
      },
    ],
  };
}
