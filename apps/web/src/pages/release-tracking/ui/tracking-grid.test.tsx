/**
 * Release Tracking list — server-paging contract.
 *
 * The grid rendered every row the endpoint returned, with no footer and no cap anywhere in the
 * stack: `/v1/reports/release-tracking` took no limit/offset, and `getReleaseFeatures` loads
 * every feature in the PROJECT before classifying into buckets (a Derived Feature is one
 * OUTSIDE the release, so the population cannot be narrowed by the release). Nine other grids
 * in the app paginate; this one did not.
 *
 * The rows are now one SERVER page. These assertions pin the two things that makes load-bearing:
 * the footer reports the whole bucket rather than the page, and Rank stays absolute so page 3
 * does not restart at 1.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import { TrackingGrid } from './tracking-grid'
import type { ReleaseTrackingReport, ReleaseTrackingRow } from '@/features/reporting/api'

const row = (i: number): ReleaseTrackingRow => ({
  id: `f-${i}`,
  itemKey: `FE-${i}`,
  name: `Feature ${i}`,
  issueType: 'feature',
  state: 'In-Progress',
  rank: i,
  childCount: 2,
  teams: [{ id: 't-1', name: 'Core Platform' }],
  mismatches: [],
  fullMismatch: false,
  plannedStartDate: null,
  plannedEndDate: null,
  progress: null,
  status: { accepted: 1, total: 4, percent: 25 },
})

/** One server page: `total` is the whole bucket, `rows` only the slice. */
const report = (page: number, pageSize: number, total: number): ReleaseTrackingReport => {
  const offset = (page - 1) * pageSize
  const count = Math.max(0, Math.min(pageSize, total - offset))
  return {
    context: { projectName: 'NXP', teamName: 'All Teams' },
    release: { id: 'r-1', name: 'R1', startDate: '2026-07-01', releaseDate: '2026-09-30' },
    unit: 'points',
    bucket: 'direct',
    summary: { direct: total, derived: 0, unparented: 0 },
    rows: Array.from({ length: count }, (_, i) => row(offset + i + 1)),
    page: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
    totals: { planned: 100, accepted: 25, preliminary: 120 },
  } as unknown as ReleaseTrackingReport
}

function renderGrid(props: Partial<Parameters<typeof TrackingGrid>[0]> = {}) {
  return render(
    <TrackingGrid
      report={report(1, 25, 60)}
      bucket="direct"
      unit="points"
      isLoading={false}
      page={1}
      pageSize={25}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
      search=""
      onSearchChange={vi.fn()}
      sortCol="rank"
      sortDir="asc"
      onSort={vi.fn()}
      {...props}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('TrackingGrid', () => {
  it('renders only the server page but reports the whole bucket in the footer', () => {
    renderGrid()

    expect(screen.getByText('FE-25')).toBeInTheDocument()
    // Row 26 lives on the next page and was never sent — the fix that bounds the payload.
    expect(screen.queryByText('FE-26')).not.toBeInTheDocument()
    // The count the reader compares against is the population, not what happens to be loaded.
    expect(screen.getByText('1–25 of 60')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
  })

  it('asks the owner for the next page rather than slicing in memory', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    renderGrid({ onPageChange })

    await user.click(screen.getByLabelText('Next page'))

    // Paging is a refetch now: the grid requests page 2, it does not produce it.
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('keeps Rank absolute across a page boundary', () => {
    renderGrid({ report: report(3, 25, 60), page: 3 })

    // Page 3 of 25 starts at row 51 — Rank must not restart at 1 (RT-AC-04).
    expect(screen.getByText('FE-51')).toBeInTheDocument()
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument()
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(screen.getByLabelText('Next page')).toBeDisabled()
  })

  it('asks the owner to search the BUCKET rather than filtering the page in memory', async () => {
    const user = userEvent.setup()
    const onSearchChange = vi.fn()
    renderGrid({ onSearchChange })

    await user.type(screen.getByPlaceholderText(/search/i), 'F')

    // The bug: this used to filter `report.rows` — one page — while the box implied the bucket.
    // §259 makes search a property of the active bucket, so it goes to the query.
    expect(onSearchChange).toHaveBeenCalledWith('F')
  })

  it('renders the server page verbatim under an active search, without filtering it again', () => {
    // The server already applied `q` to the whole bucket. Re-filtering here would drop rows the
    // server chose to send — which is what "Feature 7" used to do, leaving 1 of 25 rows on screen.
    renderGrid({ search: 'Feature 7' })

    expect(screen.getByText('FE-1')).toBeInTheDocument()
    expect(screen.getByText('FE-25')).toBeInTheDocument()
    expect(screen.getByText('1–25 of 60')).toBeInTheDocument()
  })

  it('asks the owner to sort the BUCKET when a header is clicked, and does not reorder the page', async () => {
    const user = userEvent.setup()
    const onSort = vi.fn()
    renderGrid({ onSort })

    // i18n is not initialised under test, so the header's accessible name starts with the raw key.
    await user.click(screen.getByRole('button', { name: /^columns\.id/ }))

    // RT-AC-05's sort is over the bucket; sorting the 25 rows that arrived made the caret lie.
    expect(onSort).toHaveBeenCalledWith('id')
  })

  it('renders the server page in the order it arrived, whatever the active sort is', () => {
    // `ID desc` over the bucket is the server's job. Re-sorting the page put FE-9 above FE-25 while
    // the footer still claimed rows 1–25 of the bucket's ascending rank order.
    renderGrid({ sortCol: 'id', sortDir: 'desc' })

    const keys = screen.getAllByText(/^FE-\d+$/).map((el) => el.textContent)
    expect(keys[0]).toBe('FE-1')
    expect(keys.at(-1)).toBe('FE-25')
  })

  it('says "no match" rather than "no Features in this release" when a search finds nothing', () => {
    // A search miss is not §5.1's empty-bucket state, which asserts something about the release.
    renderGrid({ report: report(1, 25, 0), search: 'zzz' })

    expect(screen.getByText('empty.noMatch.title')).toBeInTheDocument()
    expect(screen.queryByText('empty.direct.title')).not.toBeInTheDocument()
  })

  it('renders the error state rather than the bucket empty state when the query fails', () => {
    // i18n is not initialised under test, so `t()` yields raw keys.
    renderGrid({ report: undefined, isError: true })

    expect(screen.getByText('error.title')).toBeInTheDocument()
    // The bug: a network fault asserting that the release has no directly-assigned Features.
    expect(screen.queryByText('empty.direct.title')).not.toBeInTheDocument()
  })

  it('hides the footer when the bucket is empty', () => {
    renderGrid({ report: report(1, 25, 0) })

    expect(screen.queryByLabelText('Next page')).not.toBeInTheDocument()
    expect(screen.getByText('empty.direct.title')).toBeInTheDocument()
  })
})

// US-120: a Feature row is addressed by id (`/portfolio/<id>`); an Unparented work item by its key.
describe('TrackingGrid — ID link', () => {
  it('links a Feature row to its portfolio detail page by id', () => {
    renderGrid()
    expect(screen.getByTitle('FE-1').getAttribute('href')).toBe('/portfolio/f-1')
  })

  it('links an Unparented work item by its KEY, though the grid hands every row its id', () => {
    const unparented = { ...row(1), id: 'wi-9', itemKey: 'US-9', issueType: 'story' }
    renderGrid({
      bucket: 'unparented',
      report: {
        ...report(1, 25, 1),
        bucket: 'unparented',
        rows: [unparented],
      } as unknown as ReleaseTrackingReport,
    })
    expect(screen.getByTitle('US-9').getAttribute('href')).toBe('/item/US-9')
  })
})
