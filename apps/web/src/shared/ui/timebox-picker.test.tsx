import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TimeboxPicker } from './timebox-picker'

const NEWEST_FIRST = [
  { id: 'later', name: 'Sprint 2', startDate: '2026-08-27', endDate: '2026-09-02' },
  { id: 'earlier', name: 'Sprint 1', startDate: '2026-08-19', endDate: '2026-08-26' },
]

const OLDEST_FIRST = [
  { id: 'earlier', name: '2026Q2', startDate: '2026-04-01', endDate: '2026-06-30' },
  { id: 'later', name: '2026Q3', startDate: '2026-07-01', endDate: '2026-09-30' },
]

describe('TimeboxPicker chevrons', () => {
  it('the forward/next arrow moves to the chronologically LATER timebox on a newest-first feed', async () => {
    // Iterations arrive `desc(startDate)` — index 0 is the newest, so a naive `index + 1` on the
    // "next" arrow steps to an EARLIER row. This is the reversed-chevron regression.
    const onSelect = vi.fn()
    render(<TimeboxPicker items={NEWEST_FIRST} selectedId="earlier" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next iteration' }))
    expect(onSelect).toHaveBeenCalledWith('later')
  })

  it('the back/prev arrow moves to the chronologically EARLIER timebox on a newest-first feed', async () => {
    const onSelect = vi.fn()
    render(<TimeboxPicker items={NEWEST_FIRST} selectedId="later" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Previous iteration' }))
    expect(onSelect).toHaveBeenCalledWith('earlier')
  })

  it('the forward/next arrow still moves LATER on an oldest-first feed (releases)', async () => {
    // Releases arrive `asc(startDate)` — the opposite array order from iterations. The same
    // "next means later" contract must hold regardless of which order the caller's feed uses.
    const onSelect = vi.fn()
    render(<TimeboxPicker items={OLDEST_FIRST} selectedId="earlier" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next iteration' }))
    expect(onSelect).toHaveBeenCalledWith('later')
  })

  it('the back/prev arrow still moves EARLIER on an oldest-first feed (releases)', async () => {
    const onSelect = vi.fn()
    render(<TimeboxPicker items={OLDEST_FIRST} selectedId="later" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Previous iteration' }))
    expect(onSelect).toHaveBeenCalledWith('earlier')
  })

  it('disables next at the chronologically latest item, not by raw array index', () => {
    // On NEWEST_FIRST that is index 0, the opposite of every other grid's "last row" convention —
    // disabling by index alone would get this backwards on one of the two feed orders.
    render(<TimeboxPicker items={NEWEST_FIRST} selectedId="later" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Next iteration' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous iteration' })).not.toBeDisabled()
  })

  it('disables prev at the chronologically earliest item, not by raw array index', () => {
    render(<TimeboxPicker items={NEWEST_FIRST} selectedId="earlier" onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Previous iteration' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next iteration' })).not.toBeDisabled()
  })

  describe('an undated row (e.g. capacity-plans-page.tsx\'s "None" release option)', () => {
    // A real, reachable row — startDate: null — not a hypothetical one, and it must not be a
    // steppable position in time.
    const withNone = [
      { id: 'none', name: 'None', startDate: null, endDate: null },
      { id: 'earlier', name: '2026Q2', startDate: '2026-04-01', endDate: '2026-06-30' },
      { id: 'later', name: '2026Q3', startDate: '2026-07-01', endDate: '2026-09-30' },
    ]

    it('is skipped over, never landed on', async () => {
      const onSelect = vi.fn()
      render(<TimeboxPicker items={withNone} selectedId="later" onSelect={onSelect} />)
      await userEvent.click(screen.getByRole('button', { name: 'Previous iteration' }))
      expect(onSelect).toHaveBeenCalledWith('earlier')
    })

    it('disables prev at the earliest DATED row — the None row is not a valid target', () => {
      render(<TimeboxPicker items={withNone} selectedId="earlier" onSelect={vi.fn()} />)
      expect(screen.getByRole('button', { name: 'Previous iteration' })).toBeDisabled()
    })
  })
})
