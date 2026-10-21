/**
 * US-120 — the ID cell is a real link to the release's detail page, so Ctrl/Cmd+click and "Open
 * link in new tab" work. Dropping `href` would silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/features/releases/api', () => ({
  useUpdateRelease: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/shared/lib/stores/app-context.store', () => ({
  useAppContext: () => ({ project: null }),
}))

import '@/shared/i18n/i18n'
import { ReleaseRow } from './release-row'
import type { Release } from '@/features/releases/api'

const release = {
  id: 'rel-1',
  releaseKey: 'RE-1',
  name: 'Release 1',
  theme: null,
  version: null,
  startDate: '2026-01-01',
  releaseDate: '2026-03-01',
  plannedVelocity: null,
  taskEstimate: null,
  status: 'planning',
} as unknown as Release

describe('ReleaseRow — ID link', () => {
  it('links the release key to its release detail page', () => {
    render(
      <ReleaseRow release={release} canManage={false} colStyleFor={() => ({})} gutter={null} />,
    )
    expect(screen.getByTitle('RE-1').getAttribute('href')).toBe('/releases/rel-1')
  })
})
