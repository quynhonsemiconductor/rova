import type { Iteration, UpdateIterationInput } from '../domain/iteration.types';
import { diffFields, type ActivityChange, type ActivityDiffConfig } from '@modules/activity';

export interface IterationActivityDiffEntry {
  change: ActivityChange;
}

// Non-state fields only — state transitions are logged separately (commit/accept).
// Rich-text fields record a bounded plain-text preview, never markup or a whole body.
const CONFIG: ActivityDiffConfig<Record<string, unknown>> = {
  fields: ['name', 'goal', 'theme', 'notes', 'teamId', 'plannedVelocity', 'startDate', 'endDate'],
  richText: ['theme', 'notes', 'goal'],
};

/**
 * Compute the revision entries for an iteration update by diffing the persisted
 * row against the requested change set (via the shared `diffFields`). The action
 * ('iteration.updated') is applied by the caller.
 */
export function diffIteration(
  before: Iteration,
  input: UpdateIterationInput,
): IterationActivityDiffEntry[] {
  return diffFields(
    before as unknown as Record<string, unknown>,
    input as Record<string, unknown>,
    CONFIG,
  ).map((e) => ({ change: e.change }));
}
