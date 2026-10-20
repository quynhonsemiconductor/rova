import type { WorkflowStatusCategory } from '../../../../../db/schema/enums';

/**
 * Default workflow statuses seeded for every new project.
 * Mirrors the standard Rally flow: Defined → In Progress → Completed → Accepted.
 * Extracted as a named constant so tests and seeding scripts share the same
 * definition — no risk of the service and the seed diverging.
 */
export interface DefaultStatusSeed {
  name: string;
  category: WorkflowStatusCategory;
  color: string;
  position: number;
  isDefault: boolean;
}

export const DEFAULT_WORKFLOW_STATUSES: readonly DefaultStatusSeed[] = [
  { name: 'Defined', category: 'to_do', color: '#6B7280', position: 0, isDefault: true },
  { name: 'In Progress', category: 'in_progress', color: '#3B82F6', position: 1, isDefault: false },
  { name: 'Completed', category: 'done', color: '#10B981', position: 2, isDefault: false },
  { name: 'Accepted', category: 'done', color: '#059669', position: 3, isDefault: false },
] as const;

/**
 * BR18/G3: every new project starts with these five Test Case Types. The SAME five names,
 * SAME order, as migration 0129's one-time backfill for every project that existed before this
 * hook shipped — kept here as its own constant (not re-derived from the migration's SQL) so the
 * hook and any future re-seeding script share one definition, matching `DEFAULT_WORKFLOW_STATUSES`'s
 * own precedent.
 */
export const DEFAULT_TEST_CASE_TYPE_NAMES: readonly string[] = [
  'Acceptance',
  'Functional',
  'Regression',
  'Performance',
  'Usability',
] as const;
