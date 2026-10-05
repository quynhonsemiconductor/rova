/**
 * Iteration Status: what a row NAMES and what it OFFERS are two different populations.
 *
 * `GAP-P2-IS-004` (BA DEV Handoff retest 2026-08-17, Confirmed Fail): a Dev Owner was chosen inline,
 * the write reported success, the name appeared — and after a reload the cell read `No Entry` again.
 * The value was never lost. `test/e2e/dev-owner-persistence.e2e.spec.ts` proves the PATCH persists and
 * that `GET /iterations/:id/status` returns it; the row then resolved the NAME from the project OFFER
 * feed, which excludes anyone with no active `project_members` row — a Workspace Admin among them — so
 * an owner it did not carry rendered as unset. A name that fails to resolve and an empty field look
 * identical on screen, which is why this is asserted as two props rather than trusted as one list.
 *
 * `P2-IS-FR-032C` is the rule ("an Owner/Dev Owner updated successfully remains after refresh or
 * reload"), and AC3 adds that every surface reads the same value.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

/**
 * The OFFER feed, mocked at the hook. The row asks for its OWN team's candidates now
 * (`useTeamOwnerOptions(projectId, item.teamId ?? fallbackTeamId)`) rather than being handed one
 * project-wide array — the page used to pass the NO-TEAM feed, which by the assignment rule offers
 * Project Admins only, so an Editor on the selected Team was missing from both dropdowns.
 */
const offersRef: { current: Array<{ userId: string; displayName: string; email: string }> } = {
  current: [],
}
vi.mock('@/features/teams/api', () => ({
  useTeamOwnerOptions: () => ({ data: offersRef.current }),
}))

vi.mock('@/features/work-items/api', () => ({
  useUpdateWorkItem: () => ({ mutate: vi.fn(), isPending: false }),
  useSetWorkItemMilestones: () => ({ mutate: vi.fn(), isPending: false }),
  useTasks: () => ({ data: undefined, isLoading: false, isError: false }),
  useDeleteWorkItem: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import '@/shared/i18n/i18n'
import { StatusRow } from './status-row'
import type { IterationStatusItem } from '@/features/iterations/api'

/** On the team and in the project feed — the ordinary case. */
const ALICE = { userId: 'alice', displayName: 'Alice Smith', email: 'alice@qnsc.dev' }
/**
 * A Workspace Admin: reachable as an Owner (`GAP-P1-WID-007`), and absent from the project feed
 * because §2.1 and migration 0118 mean they hold no `project_members` row.
 */
const WA = { userId: 'wa-1', displayName: 'Workspace Admin', email: 'wa@qnsc.dev' }

const item = (over: Partial<IterationStatusItem> = {}): IterationStatusItem =>
  ({
    id: 'wi-1',
    itemKey: 'US-1',
    type: 'story',
    title: 'Carryover Story',
    scheduleState: 'defined',
    iterationId: 'it-1',
    isBlocked: false,
    blockedReason: null,
    planEstimate: 5,
    taskEstimate: 0,
    toDo: 0,
    actual: 0,
    taskTotal: 0,
    taskDone: 0,
    assigneeId: null,
    devOwnerId: null,
    rank: 'a',
    featureId: null,
    featureKey: null,
    featureTitle: null,
    defectCount: 0,
    openDefectCount: 0,
    milestones: [],
    ...over,
  }) as IterationStatusItem

const renderRow = (
  over: Partial<IterationStatusItem>,
  {
    names = [ALICE, WA],
    offers = [ALICE],
  }: { names?: (typeof ALICE)[]; offers?: (typeof ALICE)[] } = {},
) => {
  offersRef.current = offers
  return render(
    <StatusRow
      item={item(over)}
      rank={1}
      memberMap={new Map(names.map((m) => [m.userId, m]))}
      projectId="p-1"
      fallbackTeamId="t-1"
      milestoneOptions={[]}
      iterationOptions={[]}
      selectedIterationId="it-1"
      canEdit
      canOpenPortfolio
      colStyles={{}}
      dragEnabled={false}
      selected={false}
      onToggleSelect={() => {}}
      onOpen={() => {}}
    />,
  )
}

/**
 * The ROW names its own owner (2026-08-22).
 *
 * The cases below prove the FALLBACK still works — a name found in the directory map. These prove the
 * primary path: `assigneeName` / `devOwnerName` come joined on the read model, so the cell no longer
 * depends on any feed containing the person. That is what was broken for an Editor: the project feed
 * excludes Workspace Admins (AC-16) and the workspace directory narrows a non-admin to their own
 * projects' members and leads, so a WA owner was in NEITHER and the cell read `No Entry` while the id
 * was in the database.
 */
describe('StatusRow — the row names its own owner', () => {
  it('renders the names the row carries, with nothing in the map', () => {
    renderRow(
      {
        assigneeId: WA.userId,
        assigneeName: 'Wanda From Row',
        devOwnerId: WA.userId,
        devOwnerName: 'Devon From Row',
      },
      { names: [], offers: [] },
    )

    expect(screen.getByText('Wanda From Row')).toBeTruthy()
    expect(screen.getByText('Devon From Row')).toBeTruthy()
  })

  it('names an owner the map does not carry, without widening the picker', () => {
    // The pair the fix has to keep apart: the row NAMES anyone, the offer feed still narrows.
    // (An owner who IS in the offer feed is labelled by the select itself, so this case uses one who
    // is not — which is the reported case anyway.)
    renderRow(
      { assigneeId: WA.userId, assigneeName: 'Wanda From Row' },
      { names: [], offers: [ALICE] },
    )

    expect(screen.getByText('Wanda From Row')).toBeTruthy()
    expect(screen.queryByText('Workspace Admin')).toBeNull()
  })
})

describe('StatusRow — Dev Owner survives a reload on screen (GAP-P2-IS-004)', () => {
  it('names a Dev Owner the project OFFER feed does not carry', () => {
    renderRow({ devOwnerId: WA.userId })

    // Before the fix this cell read the `No Entry` placeholder, which is the BA's screenshot.
    expect(screen.getByText('Workspace Admin')).toBeTruthy()
  })

  it('names an Owner the offer feed does not carry either', () => {
    renderRow({ assigneeId: WA.userId })

    expect(screen.getByText('Workspace Admin')).toBeTruthy()
  })

  it('still OFFERS only the project feed, so an Owner dropdown is not the whole workspace', () => {
    // `WID-FR-016` forbids adding unrelated workspace users to Owner options, so widening the map must
    // not widen the picker — the two are separate props for exactly this reason. Asserted with the
    // picker OPEN: collapsed, this would pass whatever the options were.
    renderRow({ assigneeId: ALICE.userId }, { names: [ALICE, WA], offers: [ALICE] })

    const trigger = screen.getAllByRole('button').find((b) => /owner/i.test(b.textContent ?? ''))
    fireEvent.click(
      trigger ?? screen.getAllByRole('button').find((b) => b.textContent?.includes('Alice'))!,
    )

    // Alice appears twice with the picker open — as the trigger's label and as its one option.
    expect(screen.queryAllByText('Alice Smith').length).toBeGreaterThan(1)
    expect(screen.queryByText('Workspace Admin')).toBeNull()
  })
})

/**
 * Phase 7 CO-01 — Iteration Status shows a Story's system-managed Start Date, read-only; `Not set`
 * before it is stamped; and nothing on a Defect row, which carries no such date (SRS §5.3).
 */
describe('StatusRow — Start Date (CO-01)', () => {
  it('shows a Story its stamped Start Date as text', () => {
    renderRow({ startDate: '2026-09-01' } as Partial<IterationStatusItem>)
    expect(screen.getByText('2026-09-01')).toBeTruthy()
  })

  it('reads Not set on a Story that has not started', () => {
    renderRow({ startDate: '2026-09-01', targetEndDate: null } as Partial<IterationStatusItem>)
    renderRow({ startDate: null, targetEndDate: '2026-09-30' } as Partial<IterationStatusItem>)
    // One `Not set` per row: the unstamped Start Date and the unset Target End.
    expect(screen.getAllByText('Not set')).toHaveLength(2)
  })

  it('shows the Target End Date read-only (CO-03)', () => {
    renderRow({ targetEndDate: '2026-09-30' } as Partial<IterationStatusItem>)
    expect(screen.getByText('2026-09-30')).toBeTruthy()
  })

  it('leaves the cell empty on a Defect row', () => {
    renderRow({ type: 'defect', startDate: null } as Partial<IterationStatusItem>)
    expect(screen.queryByText('Not set')).toBeNull()
  })
})
