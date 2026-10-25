/**
 * US-120 — the ID cell is a real link to the iteration's detail page, so Ctrl/Cmd+click and "Open
 * link in new tab" work. Dropping `href` would silently fall back to an in-place-only button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/features/iterations/api', () => ({
  useUpdateIteration: () => ({ mutate: vi.fn() }),
}))

import '@/shared/i18n/i18n'
import { IterationRow } from './iteration-row'
import type { Iteration } from '@/features/iterations/api'

const iteration = {
  id: 'it-1',
  iterationKey: 'IT-1',
  name: 'Sprint 1',
  theme: null,
  startDate: '2026-01-01',
  endDate: '2026-01-14',
  plannedVelocity: null,
  taskEstimate: null,
  state: 'planning',
} as unknown as Iteration

describe('IterationRow — ID link', () => {
  it('links the iteration key to its timebox detail page', () => {
    render(
      <IterationRow
        iteration={iteration}
        canManage={false}
        colStyleFor={() => ({})}
        gutter={null}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTitle('IT-1').getAttribute('href')).toBe('/timeboxes/it-1')
  })
})
