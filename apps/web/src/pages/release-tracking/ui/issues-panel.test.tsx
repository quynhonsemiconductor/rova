/**
 * US-120 — each mismatched child's key in the Issues panel is a real link to its work-item page;
 * dropping `href` would silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import '@/shared/i18n/i18n'
import { IssuesPanel } from './issues-panel'
import type { ReleaseTrackingRow } from '@/features/reporting/api'

const row = {
  id: 'f-1',
  itemKey: 'FE-1',
  name: 'Feature 1',
  teams: [],
  mismatches: [
    { childId: 'wi-3', childKey: 'US-3', childTitle: 'Late story', itemReleaseName: 'R2' },
  ],
  fullMismatch: false,
  plannedStartDate: null,
  plannedEndDate: null,
  progress: null,
} as unknown as ReleaseTrackingRow

describe('IssuesPanel', () => {
  it('links each mismatched child key to its work-item URL', async () => {
    render(<IssuesPanel row={row} releaseName="R1" releaseStart={null} releaseEnd={null} />)
    await userEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('link', { name: 'US-3' }).getAttribute('href')).toBe('/item/US-3')
  })
})
