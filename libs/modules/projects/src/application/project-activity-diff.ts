import type { ActivityDiffConfig } from '@modules/activity';

/**
 * Fields whose changes appear in a project's Revision History. Status changes
 * (active/archived) get their own action; `settings` is a free-form object and
 * is intentionally excluded. Rich-text fields record a bounded plain-text preview,
 * never markup or a whole body.
 */
export const PROJECT_ACTIVITY_CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: ['name', 'description', 'leadId', 'startDate', 'endDate', 'status'],
  richText: ['description'],
  action: (f) => (f === 'status' ? 'project.status_changed' : 'project.updated'),
};
