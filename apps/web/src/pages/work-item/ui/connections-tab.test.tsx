/**
 * Connections tab — what a reader COPIES must match what they see. A changed file renders as its
 * action letter beside its path; the gap used to be a CSS margin only, and CSS never reaches the
 * clipboard, so copying a row yielded "Mworkspace.json".
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ScmChangeset } from '@/features/work-items/api'

const changeset = {
  id: 'cs-1',
  revision: '9f2c1ab',
  name: 'feat(nx): bump workspace to v21',
  message: 'feat(nx): bump workspace to v21',
  uri: null,
  authorName: 'Nghia-VanTrong',
  committedAt: '2026-06-24T11:02:00.000Z',
  changes: [{ action: 'M', path: 'workspace.json' }],
} as unknown as ScmChangeset

vi.mock('@/features/work-items/api', () => ({
  useWorkItemConnections: () => ({ data: { data: [], total: 0 }, isLoading: false }),
  useWorkItemChangesets: () => ({ data: { data: [changeset], total: 1 }, isLoading: false }),
}))

import '@/shared/i18n/i18n'
import { ConnectionsTab } from './connections-tab'

describe('ConnectionsTab — Changesets', () => {
  it('separates a change’s action from its path with real text, so a copy reads "M workspace.json"', () => {
    render(<ConnectionsTab workItemId="wi-1" />)
    const tab = screen.getByRole('tab', { name: /Changesets/ })
    // Radix Tabs activate on mousedown, not click.
    fireEvent.mouseDown(tab, { button: 0 })

    const change = screen.getByTitle('M workspace.json')
    expect(change.textContent).toBe('M workspace.json')
  })
})
