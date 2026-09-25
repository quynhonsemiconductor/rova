import type { WorkItem, UpdateWorkItemInput } from '../domain/work-item.types';
import { diffFields, type ActivityChange, type ActivityDiffConfig } from '@modules/activity';

/** One work-item revision entry — action always resolved (item vs task). */
export interface ActivityDiffEntry {
  action: string;
  change: ActivityChange;
}

// Rich-text fields: logged as a bounded plain-text preview of each side, never the markup and
// never the whole body (SRS §7; see `richTextPreview`).
const RICH_TEXT = [
  'description',
  'notes',
  'releaseNotes',
  'acceptanceCriteria',
  'blockedReason',
] as const;

// Field → action, per work-item vs task (SRS P1-ACTIVITY §5). Fields not listed
// fall back to the generic `${type}.updated`.
const ITEM_ACTIONS: Record<string, string> = {
  scheduleState: 'work_item.schedule_state_changed',
  flowState: 'work_item.flow_state_changed',
  priority: 'work_item.priority_changed',
  assigneeId: 'work_item.assigned',
  storyPoints: 'work_item.estimate_updated',
  estimateHours: 'work_item.estimate_updated',
};
const TASK_ACTIONS: Record<string, string> = {
  scheduleState: 'task.state_changed',
  storyPoints: 'task.estimate_updated',
  estimateHours: 'task.estimate_updated',
  todoHours: 'task.todo_updated',
  actualHours: 'task.actual_updated',
};

// Order preserved from the original diff. flowState is a work-item-only dimension
// (a task has a single state, already logged via scheduleState).
const ITEM_FIELDS = [
  'title',
  'description',
  'notes',
  'releaseNotes',
  'acceptanceCriteria',
  'isBlocked',
  'blockedReason',
  'teamId',
  'iterationId',
  'releaseId',
  'featureId',
  'statusId',
  'scheduleState',
  'flowState',
  'priority',
  'assigneeId',
  'storyPoints',
  'estimateHours',
  'todoHours',
  'actualHours',
];
const TASK_FIELDS = ITEM_FIELDS.filter((f) => f !== 'flowState');

/**
 * Compute the activity-log entries for a work-item/task update by diffing the
 * persisted row against the requested change set (via the shared `diffFields`).
 */
export function diffWorkItem(
  before: WorkItem,
  input: UpdateWorkItemInput,
  isTask: boolean,
): ActivityDiffEntry[] {
  const config: ActivityDiffConfig<Record<string, unknown>> = {
    fields: isTask ? TASK_FIELDS : ITEM_FIELDS,
    richText: RICH_TEXT as unknown as string[],
    action: (f) =>
      isTask ? (TASK_ACTIONS[f] ?? 'task.updated') : (ITEM_ACTIONS[f] ?? 'work_item.updated'),
  };
  return diffFields(
    before as unknown as Record<string, unknown>,
    input as Record<string, unknown>,
    config,
  ).map((e) => ({ action: e.action ?? 'work_item.updated', change: e.change }));
}
