import type { ActivityDiffConfig } from '@modules/activity';

/**
 * Fields whose changes appear in a milestone's Revision History. Status changes
 * get their own action; link edits (releases/projects/teams) are not scalar
 * fields and are intentionally excluded. Rich-text fields record a bounded plain-text
 * preview, never markup or a whole body.
 */
export const MILESTONE_ACTIVITY_CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: ['name', 'description', 'notes', 'status', 'ownerId', 'targetStartDate', 'targetEndDate'],
  richText: ['description', 'notes'],
  action: (f) => (f === 'status' ? 'milestone.status_changed' : 'milestone.updated'),
};
