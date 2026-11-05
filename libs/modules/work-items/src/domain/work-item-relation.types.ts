import type { WorkItemRelationType } from '../../../../../db/schema/enums';

/**
 * F6 — Work-item relations domain vocabulary.
 *
 * A relation is stored ONCE on its canonical source → target direction with a
 * `relationType`. When an item is viewed from the OTHER end, we present the
 * inverse "direction" so both items show a meaningful, human-readable link.
 */

export type RelationDirection = 'outbound' | 'inbound';

/** The label shown on the inbound (target) side of each relation type. */
export const RELATION_INVERSE: Record<WorkItemRelationType, string> = {
  blocks: 'blocked_by',
  duplicates: 'duplicated_by',
  relates_to: 'relates_to',
  depends_on: 'required_by',
};

/** Human-readable labels for both the outbound type and inbound inverse. */
export const RELATION_LABELS: Record<string, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  duplicates: 'Duplicates',
  duplicated_by: 'Duplicated by',
  relates_to: 'Relates to',
  depends_on: 'Depends on',
  required_by: 'Required by',
};

/**
 * Relation types that form a directed acyclic dependency graph — creating a
 * cycle within one of these is rejected. `relates_to` and `duplicates` are not
 * cycle-checked (they are associative, not ordering).
 */
export const ACYCLIC_RELATION_TYPES: readonly WorkItemRelationType[] = ['blocks', 'depends_on'];

export const isAcyclicRelationType = (t: WorkItemRelationType): boolean =>
  ACYCLIC_RELATION_TYPES.includes(t);

export interface WorkItemRelation {
  id: string;
  workspaceId: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: WorkItemRelationType;
  createdBy: string;
  createdAt: Date;
}

/** A relation as seen from a specific work item, with the resolved direction. */
export interface WorkItemRelationView {
  id: string;
  relationType: WorkItemRelationType;
  direction: RelationDirection;
  /** The label to render for THIS side (outbound type or inbound inverse). */
  label: string;
  /** The item on the OTHER end of the relation. */
  relatedItem: {
    id: string;
    itemKey: string;
    title: string;
    type: string;
    scheduleState: string;
  };
  /** Who created the link; `rova_delete` allows only the creator to remove it. */
  createdBy: string;
  createdAt: Date;
}

export interface CreateWorkItemRelationInput {
  sourceItemId: string;
  targetItemId: string;
  relationType: WorkItemRelationType;
  createdBy: string;
}
