import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The RELEASE end of artifact assignment (P3-REL-FR-029 "manage assigned Story/Defect work items from
 * the Release detail/artifact surface"; Q02 confirmed BOTH ends).
 *
 * A release owns no join table, so membership IS `work_items.release_id` — which is why this writes
 * through `PATCH /work-items/bulk-release`, the endpoint that already owns that column together with
 * its project scope, archived-project guard and `assertReleaseAssignable`. Removing is `releaseId:
 * null` (the mockup's "Unscheduled"), and neither direction may touch iteration or milestone
 * assignment (§7.5) — true by construction, since that is the only column the endpoint writes.
 */
vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))
const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) =>
      (
        ({
          'detailPage.artifacts.addButton': 'Add Artifact',
          'detailPage.artifacts.pickerTitle': 'Release Artifacts',
          'detailPage.artifacts.pickerSearch': 'Search stories and defects',
          'detailPage.artifacts.pickerConfirm': 'Save Artifacts',
        }) as Record<string, string>
      )[k] ?? k,
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The control needs `work_item:edit` on the release's own project as well as release management: the
// column it writes belongs to the work item, so the bulk endpoint checks that code, not a release one.
let grants: Record<string, boolean>
vi.mock('@/features/access/api', () => ({
  useProjectPermissions: () => ({ can: (code: string) => grants[code] ?? false }),
}))

import { apiClient } from '@/shared/api/http-client'
import { ReleaseArtifactsTab } from './release-artifacts-tab'

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>
const mockPATCH = apiClient.PATCH as ReturnType<typeof vi.fn>

const IN_RELEASE = {
  id: 'wi-1',
  itemKey: 'US-1',
  type: 'story',
  title: 'Already in this release',
  scheduleState: 'defined',
  priority: 'high',
  assigneeName: 'Dev One',
  storyPoints: 5,
  teamId: null,
  releaseId: 'rel-1',
}
const UNSCHEDULED = {
  id: 'wi-2',
  itemKey: 'DE-2',
  type: 'defect',
  title: 'Not in any release',
  teamId: null,
  releaseId: null,
}
/**
 * The Feature half of the same feed (`GAP-P3-REL-002`). `portfolio_items.release_id` is a real
 * assignment the Portfolio Feature detail writes, and this tab read only `work_items.release_id` — so
 * an assigned Feature displayed its release on the Feature and the release reported `0 items`.
 *
 * `priority: ''` is how the feed says ABSENT: a Feature has no priority column and no Schedule State.
 */
/**
 * A work item OUTSIDE the picker's first page. Only a server-side search can surface it, which is what
 * the BA's "the checkbox sometimes doesn't fetch" turned out to be: the row could not be offered, so it
 * could not be ticked.
 */
const FAR_AWAY = {
  id: 'wi-99',
  itemKey: 'US-99',
  type: 'story',
  title: 'Past the candidate limit',
  teamId: null,
  releaseId: null,
}

const IN_RELEASE_FEATURE = {
  id: 'pi-1',
  itemKey: 'FE-6',
  type: 'feature',
  title: 'Checkout revamp',
  scheduleState: '',
  priority: '',
  assigneeName: 'Owner Two',
  storyPoints: null,
  teamId: null,
  releaseId: 'rel-1',
}
const OTHER_RELEASE = {
  id: 'wi-3',
  itemKey: 'US-3',
  type: 'story',
  title: 'In another release',
  teamId: null,
  releaseId: 'rel-9',
}

function renderTab(canManage = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseArtifactsTab releaseId="rel-1" projectId="p1" canManage={canManage} />
    </QueryClientProvider>,
  )
}

async function openPicker() {
  const add = screen.getByRole('button', { name: 'Add Artifact' })
  await waitFor(() => expect(add).toBeEnabled())
  fireEvent.click(add)
  await screen.findByRole('checkbox', { name: 'DE-2 · Not in any release' })
}

describe('ReleaseArtifactsTab', () => {
  beforeEach(() => {
    grants = { 'work_item:edit': true }
    navigate.mockReset()
    mockPATCH.mockReset()
    mockPATCH.mockResolvedValue({
      data: { updated: 1 },
      error: undefined,
      response: { status: 200 },
    })
    mockGET.mockReset()
    mockGET.mockImplementation(
      (url: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        if (url === '/v1/releases/{id}/artifacts') {
          return Promise.resolve({
            data: {
              data: [IN_RELEASE, IN_RELEASE_FEATURE],
              pageInfo: { hasNextPage: false, nextCursor: null, limit: 50, total: 2 },
            },
            error: undefined,
            response: { status: 200 },
          })
        }
        if (url === '/v1/work-items') {
          // The server SEARCHES; this mock does too, so a picker that filters in the browser instead of
          // asking cannot pass the cases below. `FAR_AWAY` is deliberately absent from the unsearched
          // page — it stands for an item past `CANDIDATE_LIMIT`.
          const q = (opts?.params?.query?.q as string | undefined)?.toLowerCase()
          const page = [IN_RELEASE, UNSCHEDULED, OTHER_RELEASE]
          const data = q
            ? [...page, FAR_AWAY].filter(
                (w) => w.itemKey.toLowerCase().includes(q) || w.title.toLowerCase().includes(q),
              )
            : page
          return Promise.resolve({
            data: { data },
            error: undefined,
            response: { status: 200 },
          })
        }
        return Promise.resolve({ data: undefined, error: undefined, response: { status: 200 } })
      },
    )
  })

  it('renders the assigned artifacts as rows', async () => {
    renderTab()
    expect(await screen.findByText('Already in this release')).toBeInTheDocument()
  })

  it('renders an assigned FEATURE beside the work items, with its absent fields as `--`', async () => {
    renderTab()
    expect(await screen.findByText('Checkout revamp')).toBeInTheDocument()
    // `portfolio_items` has no priority column, so the feed sends `''` and the placeholder is the
    // app's one absent-value marker — never a blank cell and never a coerced value.
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })

  it('opens a FEATURE row on the Portfolio surface, not on /item/$itemKey', async () => {
    renderTab()
    // `/item/$itemKey` resolves against `work_items` only, so it would 404 for a Feature. The
    // discriminator is the row's own `type`: the two type enums are disjoint. Links since US-120, so
    // the href must name the same surface — a Ctrl+click on a Feature must not open `/item/FE-6`.
    const feature = await screen.findByRole('link', { name: /FE-6/ })
    expect(feature.getAttribute('href')).toBe('/portfolio/pi-1')
    fireEvent.click(feature)
    expect(navigate).toHaveBeenCalledWith({ to: '/portfolio/$itemId', params: { itemId: 'pi-1' } })

    const story = screen.getByRole('link', { name: /US-1/ })
    expect(story.getAttribute('href')).toBe('/item/US-1')
    fireEvent.click(story)
    expect(navigate).toHaveBeenCalledWith({ to: '/item/$itemKey', params: { itemKey: 'US-1' } })
  })

  it('pre-ticks exactly the items whose release is this one', async () => {
    renderTab()
    await openPicker()
    expect(screen.getByRole('checkbox', { name: 'US-1 · Already in this release' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'DE-2 · Not in any release' })).not.toBeChecked()
    // Another release's item is offered, not hidden: assigning it REPLACES that assignment (FR-031).
    expect(screen.getByRole('checkbox', { name: 'US-3 · In another release' })).not.toBeChecked()
  })

  /**
   * The picker SEARCHES THE SERVER (BA report, 2026-08-20: "Release checkbox sometimes not fetch when
   * clicking").
   *
   * The candidates are one page of the project's work items, and the modal used to filter that page in
   * the browser — so an item outside it could never be offered, and therefore never ticked. Typing now
   * narrows the query instead.
   */
  describe('finding an item that is not on the first page', () => {
    const searchBox = () => screen.getByRole('searchbox')

    it('offers a row only the server could have found', async () => {
      renderTab()
      await openPicker()
      expect(screen.queryByRole('checkbox', { name: /US-99/ })).toBeNull()

      fireEvent.change(searchBox(), { target: { value: 'US-99' } })

      expect(
        await screen.findByRole('checkbox', { name: 'US-99 · Past the candidate limit' }),
      ).toBeTruthy()
    })

    it('asks the server rather than filtering what it holds', async () => {
      renderTab()
      await openPicker()

      fireEvent.change(searchBox(), { target: { value: 'limit' } })

      await waitFor(() =>
        expect(mockGET).toHaveBeenCalledWith(
          '/v1/work-items',
          expect.objectContaining({
            params: expect.objectContaining({ query: expect.objectContaining({ q: 'limit' }) }),
          }),
        ),
      )
    })

    it('ADDS the found row, and leaves the release’s other members alone', async () => {
      renderTab()
      await openPicker()
      fireEvent.change(searchBox(), { target: { value: 'US-99' } })
      fireEvent.click(
        await screen.findByRole('checkbox', { name: 'US-99 · Past the candidate limit' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

      await waitFor(() => expect(mockPATCH).toHaveBeenCalled())
      const body = mockPATCH.mock.calls[0][1].body as {
        itemIds: string[]
        releaseId: string | null
      }
      expect(body.itemIds).toEqual(['wi-99'])
      expect(body.releaseId).toBe('rel-1')
    })

    /**
     * The hazard the search introduced, and the reason MEMBERSHIP is read from an unsearched query:
     * with one searched feed, untick-then-search dropped the item out of the baseline, so the save
     * computed `remove: []` and discarded the untick in silence.
     */
    it('keeps an untick that happened BEFORE a search', async () => {
      renderTab()
      await openPicker()
      fireEvent.click(screen.getByRole('checkbox', { name: 'US-1 · Already in this release' }))

      fireEvent.change(searchBox(), { target: { value: 'US-99' } })
      await screen.findByRole('checkbox', { name: 'US-99 · Past the candidate limit' })
      fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

      await waitFor(() => expect(mockPATCH).toHaveBeenCalled())
      const removal = mockPATCH.mock.calls.find(
        (c) => (c[1].body as { releaseId: string | null }).releaseId === null,
      )
      expect(removal).toBeDefined()
      expect((removal![1].body as { itemIds: string[] }).itemIds).toEqual(['wi-1'])
    })
  })

  it('ADDS an artifact by setting its release, and touches nothing else', async () => {
    renderTab()
    await openPicker()

    fireEvent.click(screen.getByRole('checkbox', { name: 'DE-2 · Not in any release' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

    await waitFor(() =>
      expect(mockPATCH).toHaveBeenCalledWith('/v1/work-items/bulk-release', {
        body: { projectId: 'p1', itemIds: ['wi-2'], releaseId: 'rel-1' },
      }),
    )
    // A diff, not a replace-set: the already-assigned item is not rewritten, and no `null` call is
    // made for items this release never held.
    expect(mockPATCH).toHaveBeenCalledTimes(1)
  })

  it('REMOVES an artifact by clearing its release to Unscheduled', async () => {
    renderTab()
    await openPicker()

    fireEvent.click(screen.getByRole('checkbox', { name: 'US-1 · Already in this release' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

    await waitFor(() =>
      expect(mockPATCH).toHaveBeenCalledWith('/v1/work-items/bulk-release', {
        body: { projectId: 'p1', itemIds: ['wi-1'], releaseId: null },
      }),
    )
    expect(mockPATCH).toHaveBeenCalledTimes(1)
  })

  it('hides the Add control from a caller who cannot edit the release', () => {
    renderTab(false)
    expect(screen.queryByRole('button', { name: 'Add Artifact' })).toBeNull()
  })

  it('hides the Add control when the caller cannot edit work items in this project', () => {
    // Release management alone is not enough: the write moves `work_items.release_id`, so the bulk
    // endpoint asks for `work_item:edit` on the release's project and would 403 without it.
    grants = {}
    renderTab(true)
    expect(screen.queryByRole('button', { name: 'Add Artifact' })).toBeNull()
  })

  it('will not open the picker until the candidate feed has arrived', async () => {
    // Deferred, not timed — the guarded failure is ordering. Opening early would freeze an empty
    // baseline into the draft, and the diff would then see nothing to add and nothing to remove: the
    // Save button would appear to work and write nothing at all.
    let releaseItems: (v: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      releaseItems = resolve
    })
    const base = mockGET.getMockImplementation() as (url: string, opts?: unknown) => unknown
    mockGET.mockImplementation((url: string, opts: unknown) => {
      if (url === '/v1/work-items') {
        return pending.then(() => ({
          data: { data: [IN_RELEASE, UNSCHEDULED, OTHER_RELEASE] },
          error: undefined,
          response: { status: 200 },
        }))
      }
      return base(url, opts)
    })

    renderTab()
    await screen.findByText('Already in this release')
    expect(screen.getByRole('button', { name: 'Add Artifact' })).toBeDisabled()

    releaseItems(undefined)
    await openPicker()
    expect(screen.getByRole('checkbox', { name: 'US-1 · Already in this release' })).toBeChecked()
  })
})
