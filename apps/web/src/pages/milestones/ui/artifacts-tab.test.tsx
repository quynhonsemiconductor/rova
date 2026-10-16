import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The MILESTONE end of the artifact link (P3-MS-FR-028 `Add Artifact`, and §4/AC-13 for removal).
 *
 * This tab was a read-only viewer — `GAP-P3-MS-001`, an open P0 — so the only way to put a story on a
 * milestone was to open the story. These tests pin the two directions of the picker and the write it
 * makes: `PUT /v1/milestones/{id}/artifacts`, the endpoint that shares
 * `assertArtifactsInMilestoneScope` with `PUT /work-items/{id}/milestones`. Writing through the
 * milestone end is what keeps the two agreeing; a UI shortcut round the shared rule is exactly the
 * defect that rule exists to prevent.
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
          'artifacts.addButton': 'Add Artifact',
          'artifacts.pickerTitle': 'Milestone Artifacts',
          'artifacts.pickerSearch': 'Search stories and defects',
          'artifacts.pickerConfirm': 'Save Artifacts',
        }) as Record<string, string>
      )[k] ?? k,
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { apiClient } from '@/shared/api/http-client'
import { ArtifactsTab } from './detail-parts'

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>
const mockPUT = apiClient.PUT as ReturnType<typeof vi.fn>

const LINKED = {
  id: 'wi-1',
  itemKey: 'US-1',
  type: 'story',
  title: 'Linked story',
  scheduleState: 'defined',
  priority: 'high',
  assigneeName: 'Dev One',
  storyPoints: 5,
}
/**
 * A directly assigned FEATURE (`GAP-P3-MS-002`). `milestone_artifacts` has been polymorphic since
 * migration 0084 and the Feature/Epic detail rail writes `entity_type = 'portfolio_item'`, so the
 * assignment persisted and displayed on the Feature while this feed hardcoded `'work_item'`.
 *
 * `priority: ''` is how the feed says ABSENT — a Feature has neither a priority column nor a
 * Schedule State.
 */
const LINKED_FEATURE = {
  id: 'pi-1',
  itemKey: 'FE-6',
  type: 'feature',
  title: 'Linked feature',
  scheduleState: '',
  priority: '',
  assigneeName: 'Owner Two',
  storyPoints: null,
}
/** A leaf story reached THROUGH that Feature — inherited scope, not a link row of its own. */
const INHERITED = {
  id: 'wi-9',
  itemKey: 'US-9',
  type: 'story',
  title: 'Inherited descendant',
  scheduleState: 'in_progress',
  priority: 'normal',
  assigneeName: 'Dev Nine',
  storyPoints: 3,
}
const UNLINKED = {
  id: 'wi-2',
  itemKey: 'US-2',
  type: 'story',
  title: 'Unlinked story',
  teamId: null,
  releaseId: null,
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function renderTab(props: { canManage?: boolean; teamIds?: string[] } = {}) {
  return wrap(
    <ArtifactsTab
      milestoneId="ms-1"
      projectIds={['p1']}
      teamIds={props.teamIds ?? []}
      canManage={props.canManage ?? true}
    />,
  )
}

/**
 * Open the picker once its baseline has arrived.
 *
 * The wait is the point, not a convenience: the control stays disabled until the link list resolves,
 * because `SelectionModal` freezes its draft from `selectedIds` at the moment it opens.
 */
async function openPicker() {
  const add = screen.getByRole('button', { name: 'Add Artifact' })
  await waitFor(() => expect(add).toBeEnabled())
  fireEvent.click(add)
  await screen.findByRole('checkbox', { name: 'US-2 · Unlinked story' })
}

describe('Milestone ArtifactsTab', () => {
  beforeEach(() => {
    navigate.mockReset()
    mockPUT.mockReset()
    mockPUT.mockResolvedValue({ data: ['wi-1'], error: undefined, response: { status: 200 } })
    mockGET.mockReset()
    mockGET.mockImplementation((url: string) => {
      // The DASHBOARD rows come from `:id/artifacts/items`; `:id/artifacts` answers with the link
      // IDS the replace-set write takes back. Serving both shapes from one path is what made this
      // tab render its empty state for every milestone.
      if (url === '/v1/milestones/{id}/artifacts/items') {
        return Promise.resolve({
          data: {
            data: [LINKED, LINKED_FEATURE, INHERITED],
            pageInfo: { hasNextPage: false, nextCursor: null, limit: 50, total: 3 },
          },
          error: undefined,
          response: { status: 200 },
        })
      }
      if (url === '/v1/milestones/{id}/artifacts') {
        return Promise.resolve({ data: ['wi-1'], error: undefined, response: { status: 200 } })
      }
      if (url === '/v1/work-items') {
        return Promise.resolve({
          data: { data: [{ ...LINKED, teamId: null, releaseId: null }, UNLINKED] },
          error: undefined,
          response: { status: 200 },
        })
      }
      return Promise.resolve({ data: undefined, error: undefined, response: { status: 200 } })
    })
  })

  it('renders the linked artifacts as rows', async () => {
    renderTab()
    expect(await screen.findByText('Linked story')).toBeInTheDocument()
  })

  it('renders a directly assigned Feature and its inherited descendants', async () => {
    renderTab()
    expect(await screen.findByText('Linked feature')).toBeInTheDocument()
    expect(screen.getByText('Inherited descendant')).toBeInTheDocument()
    // `portfolio_items` has no priority column, so `''` becomes the app's one absent-value marker.
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
  })

  it('opens a Feature row on the Portfolio surface, not on /item/$itemKey', async () => {
    renderTab()
    // Links since US-120, so the href must name the SAME surface the click navigates to — or a
    // Ctrl+click on a Feature would open `/item/FE-6` in the new tab and 404.
    const feature = await screen.findByRole('link', { name: /FE-6/ })
    expect(feature.getAttribute('href')).toBe('/portfolio/pi-1')
    fireEvent.click(feature)
    expect(navigate).toHaveBeenCalledWith({ to: '/portfolio/$itemId', params: { itemId: 'pi-1' } })

    const story = screen.getByRole('link', { name: /US-9/ })
    expect(story.getAttribute('href')).toBe('/item/US-9')
    fireEvent.click(story)
    expect(navigate).toHaveBeenCalledWith({ to: '/item/$itemKey', params: { itemKey: 'US-9' } })
  })

  it('ADDS an artifact through the milestone end, preserving the ones already linked', async () => {
    renderTab()
    await openPicker()

    fireEvent.click(screen.getByRole('checkbox', { name: 'US-2 · Unlinked story' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

    // The payload REPLACES the list, so it has to carry `wi-1` too — a set built from the visible
    // page alone would silently unlink everything else on the milestone.
    //
    // It must NOT carry `pi-1` or `wi-9`. The baseline comes from `:id/artifacts`, which is the
    // DIRECT work-item link list, while the rows above also include a portfolio link and an inherited
    // descendant. Building the baseline from the rows instead would post the Feature's id as a
    // `workItemId` (refused) and promote the inherited story to a direct assignment nobody made —
    // which is the whole reason the inherited set is computed on read and never materialised.
    await waitFor(() =>
      expect(mockPUT).toHaveBeenCalledWith('/v1/milestones/{id}/artifacts', {
        params: { path: { id: 'ms-1' } },
        body: { workItemIds: ['wi-1', 'wi-2'] },
      }),
    )
  })

  it('REMOVES an artifact by unticking it', async () => {
    renderTab()
    await openPicker()

    fireEvent.click(screen.getByRole('checkbox', { name: 'US-1 · Linked story' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Artifacts' }))

    await waitFor(() =>
      expect(mockPUT).toHaveBeenCalledWith('/v1/milestones/{id}/artifacts', {
        params: { path: { id: 'ms-1' } },
        body: { workItemIds: [] },
      }),
    )
  })

  it('offers only candidates the milestone scope accepts', async () => {
    // A milestone with Team scope: a team-agnostic item is OUT of that scope, not exempt from it —
    // the same rule `assertArtifactsInMilestoneScope` applies server-side, so the picker cannot
    // offer a row whose save would come back `MILESTONE_TEAM_MISMATCH`.
    renderTab({ teamIds: ['team-a'] })
    const add = screen.getByRole('button', { name: 'Add Artifact' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    await screen.findByRole('checkbox', { name: 'Select all' })
    expect(screen.queryByRole('checkbox', { name: 'US-2 · Unlinked story' })).toBeNull()
  })

  it('hides the Add control from a caller who cannot edit the milestone', () => {
    renderTab({ canManage: false })
    expect(screen.queryByRole('button', { name: 'Add Artifact' })).toBeNull()
  })

  it('will not open the picker until the link baseline has arrived', async () => {
    // Deferred, not timed: the failure this guards is ordering, and a `waitFor` timeout would only
    // ever prove the render was slow. `SelectionModal` copies `selectedIds` into its draft on the
    // closed→open transition and a draft SHADOWS the baseline, so opening early would freeze `[]` in
    // — and this write is a replace-set, so saving that draft unlinks every existing artifact.
    let releaseIds: (v: unknown) => void = () => {}
    const pendingIds = new Promise((resolve) => {
      releaseIds = resolve
    })
    const base = mockGET.getMockImplementation() as (url: string, opts?: unknown) => unknown
    mockGET.mockImplementation((url: string, opts: unknown) => {
      if (url === '/v1/milestones/{id}/artifacts') {
        return pendingIds.then(() => ({
          data: ['wi-1'],
          error: undefined,
          response: { status: 200 },
        }))
      }
      return base(url, opts)
    })

    renderTab()
    // Candidates have landed; the baseline has not, so the control is still refusing to open.
    await screen.findByText('Linked story')
    expect(screen.getByRole('button', { name: 'Add Artifact' })).toBeDisabled()

    releaseIds(undefined)
    await openPicker()
    expect(screen.getByRole('checkbox', { name: 'US-1 · Linked story' })).toBeChecked()
  })
})
