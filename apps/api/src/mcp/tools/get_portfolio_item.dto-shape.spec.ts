import { describe, expect, it } from 'vitest';
import { PortfolioItemDetailResponseDto } from '@modules/portfolio/interface/http/dto/portfolio-item-response.dto';
import { shapePortfolioDetail } from './get_portfolio_item';

/**
 * The REAL detail DTO (GET /v1/portfolio-items/:id) plus the paged children wrapper
 * (PortfolioChildSchema rows). The detail schema is module-private, so the fixture parses
 * through the DTO's own zod schema (`createZodDto` exposes it as `.schema`) — parse() throws
 * here if the producer drifts, instead of at an agent's first question.
 */
const DETAIL = PortfolioItemDetailResponseDto.schema.parse({
  id: '0194a000-0000-7000-8000-000000000001',
  workspaceId: '0194a000-0000-7000-8000-000000000002',
  projectId: '0194a000-0000-7000-8000-000000000003',
  projectName: 'Payments Platform',
  itemKey: 'FE-318',
  type: 'feature',
  name: 'Feature 318',
  description: null,
  notes: null,
  releaseNotes: null,
  whatSuccessLooksLike: null,
  state: 'developing',
  preliminaryEstimate: 'l',
  refinedEstimate: 8,
  refinedItemCountEstimate: 5,
  parentId: null,
  parentKey: null,
  teamId: null,
  teamName: null,
  releaseId: null,
  releaseName: null,
  ownerId: null,
  ownerName: 'Member One',
  plannedStartDate: '2026-10-01',
  plannedEndDate: '2026-11-01',
  marketReleaseDate: null,
  rank: '1000',
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  childFeatureCount: 0,
  rollup: {
    rollupPoints: 13,
    rollupCount: 4,
    acceptedPoints: 3,
    acceptedCount: 2,
    completedPoints: 5,
    completedCount: 2,
  },
  progress: {
    percentDoneByPlanEstimate: 0.25,
    percentDoneByCount: null,
    estimatedProgressByPoints: null,
    estimatedProgressByCount: null,
  },
  health: { state: 'on_track', percentDone: 25, percentElapsed: 50, indeterminate: null },
  estimate: {
    points: { value: 8, tier: 'refined' },
    count: { value: 5, tier: 'refined' },
  },
  acceptedChildren: {
    total: { points: 3, count: 2, acceptedPoints: 3, acceptedCount: 2 },
    byType: [{ type: 'story', points: 3, count: 2, acceptedPoints: 3, acceptedCount: 2 }],
  },
  milestones: [],
});

function childRow(id: string) {
  return {
    id,
    itemKey: 'PAY-7',
    type: 'story' as const,
    title: 'Child story',
    scheduleState: 'in_progress',
    storyPoints: 3,
    priority: 'high' as const,
    iterationId: null,
    iterationName: null,
    rank: '1000',
    projectId: '0194a000-0000-7000-8000-000000000003',
    releaseId: null,
    teamId: null,
    assigneeId: null,
    releaseName: null,
    projectName: 'Payments Platform',
    teamName: null,
    ownerName: null,
  };
}

const CHILDREN_PAGE = {
  data: [childRow('0194a000-0000-7000-8000-000000000004')],
  pageInfo: { hasNextPage: false, nextCursor: null },
};

describe('shapePortfolioDetail (detail + paged children -> tool payload)', () => {
  it('maps estimate/rollup/progress and unwraps the paged children body', () => {
    const out = shapePortfolioDetail(DETAIL, CHILDREN_PAGE);
    expect(out.id).toBe(DETAIL.id);
    expect(out.itemKey).toBe('FE-318');
    expect(out.state).toBe('developing');
    expect(out.estimate).toEqual({
      points: { value: 8, tier: 'refined' },
      count: { value: 5, tier: 'refined' },
    });
    expect(out.rollup).toEqual({
      rollupPoints: 13,
      rollupCount: 4,
      acceptedPoints: 3,
      acceptedCount: 2,
    });
    expect(out.progress).toEqual({ percentDoneByPlanEstimate: 0.25, percentDoneByCount: null });
    expect((out.children as unknown[]).length).toBe(1);
    expect(out.truncated).toBeUndefined();
  });

  it('a Feature with more than 50 children caps them and sets truncated', () => {
    const many = {
      ...CHILDREN_PAGE,
      data: Array.from({ length: 60 }, (_, i) =>
        childRow(`0194a000-0000-7000-8000-${String(i).padStart(12, '0')}`),
      ),
      pageInfo: { hasNextPage: true },
    };
    const out = shapePortfolioDetail(DETAIL, many);
    expect((out.children as unknown[]).length).toBe(50);
    expect(out.truncated).toBe(true);
  });

  it('null-guard: an empty detail body yields a payload with undefined core fields', () => {
    const out = shapePortfolioDetail({}, { data: [] });
    expect(out['id']).toBeUndefined();
  });
});
