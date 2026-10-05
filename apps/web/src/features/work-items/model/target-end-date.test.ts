import { describe, expect, it } from 'vitest'

import { isEnabledDate, resolveSelection } from './target-end-date'

const A = {
  id: 'A',
  name: 'A',
  iterationKey: null,
  state: 'committed',
  startDate: '2030-01-07',
  endDate: '2030-01-18',
  teamId: 't',
}
const B = {
  ...A,
  id: 'B',
  name: 'B',
  state: 'planning',
  startDate: '2030-01-21',
  endDate: '2030-02-01',
}
const O = {
  ...A,
  id: 'O',
  name: 'O',
  state: 'planning',
  startDate: '2030-01-28',
  endDate: '2030-02-08',
}
const current = {
  id: 'A',
  name: 'A',
  iterationKey: null,
  state: 'committed',
  startDate: A.startDate,
  endDate: A.endDate,
  eligible: true,
}
const options = { current, eligibleIterations: [A, B, O], minDate: '2030-01-07' }

describe('isEnabledDate', () => {
  it('disables a day before minDate', () => {
    expect(isEnabledDate('2030-01-06', options)).toBe(false)
  })
  it('enables a day in the current Iteration', () => {
    expect(isEnabledDate('2030-01-10', options)).toBe(true)
  })
  it('disables a day outside every eligible Iteration', () => {
    expect(isEnabledDate('2030-03-01', options)).toBe(false)
  })
  it('R6 — disables an accepted current Iteration’s own days', () => {
    const accepted = {
      ...options,
      current: { ...current, state: 'accepted', eligible: false },
      eligibleIterations: [B],
    }
    expect(isEnabledDate('2030-01-10', accepted)).toBe(false)
    expect(isEnabledDate('2030-01-22', accepted)).toBe(true)
  })
})

describe('resolveSelection', () => {
  it('is a plain save inside the current Iteration', () => {
    expect(resolveSelection('2030-01-18', options)).toEqual({ kind: 'inside' })
  })
  it('proposes the single target', () => {
    expect(resolveSelection('2030-01-22', options)).toEqual({ kind: 'carryover', targets: [B] })
  })
  it('offers every overlapping target', () => {
    expect(resolveSelection('2030-01-30', options)).toEqual({ kind: 'carryover', targets: [B, O] })
  })
  it('has no destination when nothing contains the date', () => {
    expect(resolveSelection('2030-03-01', options)).toEqual({ kind: 'carryover', targets: [] })
  })
})
