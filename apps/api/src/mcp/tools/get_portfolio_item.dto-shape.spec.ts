import { describe, expect, it } from 'vitest';
import { shapePortfolioDetail } from './get_portfolio_item';

/** The real detail DTO shape (PortfolioItemDetailResponseDto) plus the paged children wrapper. */
const DETAIL = {
  id: 'pid',
  itemKey: 'FE-318',
  type: 'feature',
  name: 'Feature 318',
  state: 'allocated',
  projectId: 'proj',
  projectName: 'Payments Platform',
  parentKey: null,
  ownerName: 'Member One',
  plannedStartDate: '2026-10-01',
  plannedEndDate: '2026-11-01',
  estimate: {
    points: { value: 8, tier: 'refined' },
    count: { value: 5, tier: 'refined' },
  },
  rollup: { rollupPoints: 13, rollupCount: 4, acceptedPoints: 3, acceptedCount: 2 },
  progress: { percentDoneByPlanEstimate: 0.25, percentDoneByCount: null },
};

const CHILDREN_PAGE = {
  data: [
    {
      id: 'c1',
      itemKey: 'PAY-7',
      type: 'story',
      title: 'Child story',
      scheduleState: 'in_progress',
    },
  ],
  pageInfo: { hasNextPage: false, nextCursor: null },
};

describe('shapePortfolioDetail (detail + paged children -> tool payload)', () => {
  it('maps estimate/rollup/progress and unwraps the paged children body', () => {
    const out = shapePortfolioDetail(DETAIL, CHILDREN_PAGE);
    expect(out.id).toBe('pid');
    expect(out.itemKey).toBe('FE-318');
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
      data: Array.from({ length: 60 }, () => CHILDREN_PAGE.data[0]),
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

  it('an empty detail body produces a payload with undefined core fields (deny happens before shaping)', () => {
    const out = shapePortfolioDetail({}, { data: [] });
    expect(out['id']).toBeUndefined();
  });
});
