import type { ActivityDiffConfig } from '@modules/activity';

/**
 * Fields whose changes appear in a release's Revision History. Status changes get
 * their own action so the feed reads "changed status" distinctly; everything else
 * is a generic 'release.updated'. Rich-text fields record a bounded plain-text
 * preview, never markup or a whole body.
 */
export const RELEASE_ACTIVITY_CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: [
    'name',
    'description',
    'theme',
    'notes',
    'startDate',
    'releaseDate',
    'plannedVelocity',
    'planEstimate',
    'version',
    'releaseNotes',
    'status',
  ],
  richText: ['description', 'theme', 'notes', 'releaseNotes'],
  action: (f) => (f === 'status' ? 'release.status_changed' : 'release.updated'),
};
