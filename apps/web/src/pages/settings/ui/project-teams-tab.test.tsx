import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * GAP-P4-SET-004 — destructive confirmations on the project Teams tab.
 *
 * Two separate defects, and they fail in opposite directions:
 *   • RESTORE had NO confirmation at all — `updateTeam.mutate({ status: 'active' })` fired straight
 *     from the icon's `onClick`, so one stray click on a 13px glyph put a disbanded team back into
 *     every picker and assignment surface.
 *   • DEACTIVATE named the team but committed on one click; it now needs the name typed.
 *
 * What is asserted is that the typed gate BLOCKS THE WRITE, not merely that a dialog appeared: a
 * confirmation that opens and then commits on any click is the defect with extra steps. The
 * PATCH-not-called assertions are the point of each test.
 */

vi.mock('@/shared/api/http-client', () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))
vi.mock('@/shared/lib/stores/app-context.store', () => ({
  useAppContext: (selector: (s: unknown) => unknown) =>
    selector({ workspace: { workspaceId: 'ws-1' } }),
}))

import '@/shared/i18n/i18n'
import { apiClient } from '@/shared/api/http-client'
import { ProjectTeamsTab } from './project-teams-tab'

// Radix's popover measures its trigger; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver

const mockGET = apiClient.GET as ReturnType<typeof vi.fn>
const mockPATCH = apiClient.PATCH as ReturnType<typeof vi.fn>

/** `GET /projects/:id/teams` returns project_team LINK rows — `.teamId` is the real team id. */
const LINKS = [
  {
    id: 'link-a',
    teamId: 'team-a',
    key: 'ALPHA',
    name: 'Team Alpha',
    status: 'active',
    leadId: null,
    memberCount: 3,
  },
  {
    id: 'link-b',
    teamId: 'team-b',
    key: 'BETA',
    name: 'Team Beta',
    status: 'archived',
    leadId: null,
    memberCount: 1,
  },
]

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ProjectTeamsTab projectId="p-1" isWA onOpenTeam={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** The typed-confirmation input, addressed by the placeholder `ConfirmDialog` gives it. */
function typeConfirmation(expected: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(expected), { target: { value } })
}

describe('ProjectTeamsTab — deactivate needs the team name TYPED', () => {
  beforeEach(() => {
    mockGET.mockReset()
    mockPATCH.mockReset()
    mockPATCH.mockResolvedValue({ data: LINKS[0], error: undefined })
    mockGET.mockImplementation((path: string) => {
      if (path === '/v1/projects/{id}/teams') return Promise.resolve({ data: LINKS })
      return Promise.resolve({ data: [] })
    })
  })

  async function openDeactivate() {
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate team' }))
    return screen.findByText(/Deactivate Team Alpha\?/)
  }

  it('keeps Deactivate disabled until the name matches EXACTLY, and writes nothing before that', async () => {
    renderTab()
    await openDeactivate()
    const confirm = screen.getByRole('button', { name: 'Deactivate' })
    expect(confirm).toBeDisabled()

    // A near miss is still a miss — the match is case-sensitive.
    typeConfirmation('Team Alpha', 'team alpha')
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled()

    // And a click while disabled must not slip a write through.
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(mockPATCH).not.toHaveBeenCalled()
  })

  it('writes the archive only once the exact name is typed', async () => {
    renderTab()
    await openDeactivate()
    typeConfirmation('Team Alpha', 'Team Alpha')

    const confirm = screen.getByRole('button', { name: 'Deactivate' })
    await waitFor(() => expect(confirm).not.toBeDisabled())
    fireEvent.click(confirm)

    await waitFor(() => expect(mockPATCH).toHaveBeenCalled())
    expect(mockPATCH.mock.calls[0][0]).toBe('/v1/teams/{id}')
    expect(mockPATCH.mock.calls[0][1]).toMatchObject({
      params: { path: { id: 'team-a' } },
      body: { status: 'archived' },
    })
  })
})

describe('ProjectTeamsTab — restore is CONFIRMED but not typed', () => {
  beforeEach(() => {
    mockGET.mockReset()
    mockPATCH.mockReset()
    mockPATCH.mockResolvedValue({ data: LINKS[1], error: undefined })
    mockGET.mockImplementation((path: string) => {
      if (path === '/v1/projects/{id}/teams') return Promise.resolve({ data: LINKS })
      return Promise.resolve({ data: [] })
    })
  })

  it('asks before restoring, and writes NOTHING on the icon click alone', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore team' }))

    expect(await screen.findByText(/Restore Team Beta\?/)).toBeTruthy()
    expect(mockPATCH).not.toHaveBeenCalled()
  })

  it('names the target but does NOT demand it be typed — a restore destroys nothing', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore team' }))
    await screen.findByText(/Restore Team Beta\?/)

    // No typed-confirmation input, and the confirm is live immediately.
    expect(screen.queryByPlaceholderText('Team Beta')).toBeNull()
    expect(screen.getByRole('button', { name: 'Restore' })).not.toBeDisabled()
  })

  it('restores on confirm', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore team' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(mockPATCH).toHaveBeenCalled())
    expect(mockPATCH.mock.calls[0][1]).toMatchObject({
      params: { path: { id: 'team-b' } },
      body: { status: 'active' },
    })
  })

  it('abandons on Cancel without writing', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore team' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(mockPATCH).not.toHaveBeenCalled()
  })
})

/**
 * The BA's Workspace-Admin team-membership ruling — the FE half, and the half of §2.1 it did NOT
 * reverse.
 *
 * A Workspace Admin may now be manually added to an ACTIVE Team and be that Team's Lead, so this
 * modal no longer filters `roleSlug === 'workspace_admin'` out of `eligible`. What still holds is
 * that they hold no `project_members` row: team membership is operational scope only and "must NOT
 * create or require an Admin/Editor Project Access assignment".
 *
 * The payload assertion is the one that matters. Everything else here is visible on screen and would
 * be noticed; a stray `POST /v1/projects/{id}/members` for a Workspace Admin is invisible — it
 * succeeds, shows nothing, and `AccessService.effectiveAssignments` turns the row into a live
 * Project Admin grant the moment that user is demoted. Reinstating the old `filter` fails the two
 * candidate tests; dropping the `level === null` skip in `syncMemberAccess` fails only that one.
 */
const WS_ROSTER = [
  {
    id: 'wm-1',
    userId: 'u-ed',
    displayName: 'Eddie Editor',
    email: 'eddie@acme.test',
    status: 'active',
    roleSlug: null,
  },
  {
    id: 'wm-2',
    userId: 'u-wa',
    displayName: 'Wanda Admin',
    email: 'wanda@acme.test',
    status: 'active',
    roleSlug: 'workspace_admin',
  },
]

describe('TeamFormModal — a Workspace Admin is a Team candidate, but never a project_members row', () => {
  const mockPOST = apiClient.POST as ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGET.mockReset()
    mockPOST.mockReset()
    mockPOST.mockResolvedValue({ data: { id: 'team-new' }, error: undefined })
    mockGET.mockImplementation((path: string) => {
      if (path === '/v1/projects/{id}/teams') return Promise.resolve({ data: LINKS })
      if (path === '/v1/workspaces/{id}/members-with-profile')
        return Promise.resolve({ data: WS_ROSTER })
      if (path === '/v1/workspaces/{id}/member-options')
        return Promise.resolve({
          data: WS_ROSTER.map((m) => ({
            userId: m.userId,
            displayName: m.displayName,
            email: m.email,
            avatarUrl: null,
            assignable: true,
          })),
        })
      // Eddie holds Editor on this project — which is what makes him a candidate at all under
      // `PM-FR-020` ("active users already eligible in the selected Project"). Wanda needs no row:
      // §2.1 keeps a Workspace Admin off `project_members` and the rule admits them anyway.
      if (path === '/v1/projects/{id}/members')
        return Promise.resolve({
          data: [
            {
              id: 'pm-ed',
              userId: 'u-ed',
              workspaceId: 'ws-1',
              projectId: 'p-1',
              accessLevel: 'editor',
              status: 'active',
              displayName: 'Eddie Editor',
              email: 'eddie@acme.test',
              joinedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              teamCount: 0,
            },
          ],
        })
      return Promise.resolve({ data: [] })
    })
  })

  async function openCreate() {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Add team' }))
    // Both the modal title and its submit read `Create team`, so address the FIELD that only the
    // open modal has.
    return screen.findByPlaceholderText('e.g. Core Platform')
  }

  /**
   * Team key auto-fills from the name, and stays the reader's to change (BA report, 2026-08-20).
   *
   * The field was required, empty, and showed `CP` as a placeholder with nothing filling it in — the BA
   * read that placeholder as a stray value, which is the clearest sign it looked like one.
   */
  describe('the Team key the form offers', () => {
    const keyField = () => screen.getByPlaceholderText('CP') as HTMLInputElement

    it('derives from the name as it is typed', async () => {
      const nameField = await openCreate()
      expect(keyField().value).toBe('')

      fireEvent.change(nameField, { target: { value: 'Core Platform' } })

      expect(keyField().value).toBe('CP')
    })

    it('keeps following the name until the reader edits the key', async () => {
      const nameField = await openCreate()
      fireEvent.change(nameField, { target: { value: 'Core Platform' } })
      fireEvent.change(nameField, { target: { value: 'Quality Assurance Team' } })

      expect(keyField().value).toBe('QAT')
    })

    it('lets a typed key win, and stop following', async () => {
      const nameField = await openCreate()
      fireEvent.change(nameField, { target: { value: 'Core Platform' } })
      fireEvent.change(keyField(), { target: { value: 'PLAT' } })
      fireEvent.change(nameField, { target: { value: 'Something Else' } })

      expect(keyField().value).toBe('PLAT')
    })

    it('hands control back to the suggestion when the key is cleared', async () => {
      // Otherwise clearing the box strands the reader on an empty REQUIRED field with a value they
      // cannot get back without retyping the name.
      const nameField = await openCreate()
      fireEvent.change(nameField, { target: { value: 'Core Platform' } })
      fireEvent.change(keyField(), { target: { value: 'PLAT' } })
      fireEvent.change(keyField(), { target: { value: '' } })

      expect(keyField().value).toBe('CP')
    })

    /**
     * A key could not be changed once saved: this input was disabled while editing, and the PATCH left
     * the key out entirely. So renaming a team stranded the old name's key on it — `Observability`
     * became `DevOps` and kept `OBSERVABIL`, which had to be corrected with SQL against production.
     *
     * The rule came from a project key prefixing every item id, which `0036_type_prefixed_item_keys`
     * ended.
     */
    it('offers the stored key for editing rather than disabling it', async () => {
      renderTab()
      fireEvent.click((await screen.findAllByLabelText('Edit team')).at(0)!)

      const field = (await screen.findByDisplayValue('ALPHA')) as HTMLInputElement
      expect(field).toBeEnabled()
    })

    /** A rename must not re-key the team: `KB` and `MT` were chosen, not derived from a name. */
    it('does not re-derive the key when the name is edited', async () => {
      renderTab()
      fireEvent.click((await screen.findAllByLabelText('Edit team')).at(0)!)
      const field = (await screen.findByDisplayValue('ALPHA')) as HTMLInputElement

      fireEvent.change(screen.getByPlaceholderText('e.g. Core Platform'), {
        target: { value: 'Something Entirely Different' },
      })

      expect(field.value).toBe('ALPHA')
    })

    it('sends the corrected key in the PATCH', async () => {
      renderTab()
      fireEvent.click((await screen.findAllByLabelText('Edit team')).at(0)!)
      const field = (await screen.findByDisplayValue('ALPHA')) as HTMLInputElement

      fireEvent.change(field, { target: { value: 'devops' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(mockPATCH).toHaveBeenCalledWith(
          expect.stringContaining('/teams/'),
          expect.objectContaining({ body: expect.objectContaining({ key: 'DEVOPS' }) }),
        ),
      )
    })

    it('enables Create team on the derived key alone', async () => {
      const nameField = await openCreate()
      fireEvent.change(nameField, { target: { value: 'Core Platform' } })

      const submit = screen.getAllByRole('button', { name: 'Create team' }).at(-1)!
      expect(submit).toBeEnabled()
    })
  })

  /**
   * `PM-FR-021` (BA 2026-08-22): "Team Lead must be an active Team member." So the lead options are
   * the rows ticked in this form, not the directory — and a Workspace Admin is still among them once
   * ticked, which is the reversed half of §2.1 this case was written for.
   */
  it('offers only ticked members as Team lead, Workspace Admin included', async () => {
    await openCreate()

    // Nobody ticked yet: nothing to lead with.
    fireEvent.click(await screen.findByRole('button', { name: 'Team lead' }))
    expect(screen.queryByRole('button', { name: 'Wanda Admin' })).toBeNull()

    // Close the picker before ticking, then reopen: the option list is rebuilt from the roster.
    fireEvent.click(screen.getByRole('button', { name: 'Team lead' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add Wanda Admin to this team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Team lead' }))
    expect(await screen.findByRole('button', { name: 'Wanda Admin' })).toBeTruthy()
    // Not ticked, so not a candidate — the rule cuts both ways.
    expect(screen.queryByRole('button', { name: 'Eddie Editor' })).toBeNull()
  })

  it('offers a Workspace Admin as a Team MEMBER candidate', async () => {
    await openCreate()
    expect(
      await screen.findByRole('checkbox', { name: 'Add Wanda Admin to this team' }),
    ).toBeTruthy()
  })

  /**
   * `PM-FR-021`: "Project Access is read-only in this flow." The level select is gone for EVERYONE,
   * not only for a Workspace Admin — this form now decides membership and nothing else, and the level
   * shown beside a row is the existing grant that made the person eligible.
   */
  it('offers no access-level select at all, for any row', async () => {
    await openCreate()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add Wanda Admin to this team' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add Eddie Editor to this team' }))

    expect(screen.getAllByText('Workspace Admin').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Access level for Wanda Admin' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Access level for Eddie Editor' })).toBeNull()
  })

  it('adds both to the team and writes no Project Access at all', async () => {
    await openCreate()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add Wanda Admin to this team' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add Eddie Editor to this team' }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Core Platform'), {
      target: { value: 'Core Platform' },
    })
    fireEvent.change(screen.getByPlaceholderText('CP'), { target: { value: 'CP' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() =>
      expect(mockPOST.mock.calls.some((c) => c[0] === '/v1/workspaces/{workspaceId}/teams')).toBe(
        true,
      ),
    )

    // Team membership: BOTH, because a Workspace Admin may now hold one.
    const create = mockPOST.mock.calls.find((c) => c[0] === '/v1/workspaces/{workspaceId}/teams')!
    expect((create[1].body as { memberUserIds: string[] }).memberUserIds.sort()).toEqual([
      'u-ed',
      'u-wa',
    ])

    // And NO project-access write for anybody: `PM-FR-021` — "Adding or removing a Team member never
    // creates or changes Project Access." This used to write the Editor's level here, which is the
    // grant RBE-06 implied from a roster row; that rule is retired.
    expect(mockPOST.mock.calls.some((c) => c[0] === '/v1/projects/{id}/members')).toBe(false)
  })
})
