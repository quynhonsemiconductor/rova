import { describe, expect, it } from 'vitest';
import type { DrizzleDB } from '@platform';
import { WorkItemRelationDrizzleRepository } from './work-item-relation.drizzle-repository';

/**
 * `rova_delete` may remove a relation only when the caller created it, so the relation VIEW has
 * to carry `created_by`. The SQL projection is the only place that field can be lost; assert it
 * is selected in BOTH directions (outbound and inbound).
 */
describe('WorkItemRelationDrizzleRepository.listForItem', () => {
  it('projects createdBy on both the outbound and inbound reads', async () => {
    const projections: Array<Record<string, unknown>> = [];
    const row = {
      id: 'rel-1',
      relationType: 'blocks' as const,
      createdBy: 'user-1',
      createdAt: new Date('2026-11-05T10:00:00Z'),
      otherId: 'wi-2',
      otherKey: 'US-2',
      otherTitle: 'Other',
      otherType: 'story',
      otherScheduleState: 'defined',
    };
    const db = {
      select: (projection: Record<string, unknown>) => {
        projections.push(projection);
        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => [row],
            }),
          }),
        };
      },
    };
    const repo = new WorkItemRelationDrizzleRepository(db as unknown as DrizzleDB);

    const views = await repo.listForItem('wi-1', 'ws-1');

    expect(projections).toHaveLength(2);
    for (const projection of projections) {
      expect(projection).toHaveProperty('createdBy');
    }
    expect(views.map((view) => view.createdBy)).toEqual(['user-1', 'user-1']);
  });
});
