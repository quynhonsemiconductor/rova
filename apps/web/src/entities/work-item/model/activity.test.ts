/**
 * `carryoverActivityLabel` (Phase 7 CO-07) in isolation — PR #653 review.
 *
 * The Revision History tab test covers the rendered sentences; this pins the MAPPING, so a renamed
 * metadata key at the writer, or `metadata` dropped from the activity DTO, fails here instead of
 * silently rendering every entry as "Unscheduled".
 */
import { describe, expect, it } from 'vitest'

import { carryoverActivityLabel } from './activity'

describe('carryoverActivityLabel', () => {
  it('maps a Carryover to its key with source, target and date from metadata', () => {
    expect(
      carryoverActivityLabel({
        action: 'work_item.carried_over',
        changes: { field: 'iterationId', old: 'a', new: 'b' },
        metadata: {
          sourceIterationName: 'Sprint A',
          targetIterationName: 'Sprint B',
          targetEndDate: '2030-01-25',
        },
      }),
    ).toEqual({
      key: 'carryover:history.carriedOver',
      values: { source: 'Sprint A', target: 'Sprint B', date: '2030-01-25' },
    })
  })

  it('maps a Manual Move to its key with source and target', () => {
    expect(
      carryoverActivityLabel({
        action: 'work_item.iteration_moved',
        changes: { field: 'iterationId', old: 'b', new: 'a' },
        metadata: { sourceIterationName: 'Sprint B', targetIterationName: 'Sprint A' },
      }),
    ).toEqual({
      key: 'carryover:history.manualMove',
      values: { source: 'Sprint B', target: 'Sprint A' },
    })
  })

  it('maps a Target End change from the diff, not metadata', () => {
    expect(
      carryoverActivityLabel({
        action: 'work_item.target_end_date_changed',
        changes: { field: 'targetEndDate', old: null, new: '2030-01-15' },
      }),
    ).toEqual({
      key: 'carryover:history.targetEndChanged',
      values: { old: '', new: '2030-01-15' },
    })
  })

  it.each([
    ['missing metadata', undefined],
    ['null metadata', null],
  ])('yields empty values (the renderer’s fallback) for %s', (_label, metadata) => {
    expect(
      carryoverActivityLabel({ action: 'work_item.carried_over', changes: null, metadata }),
    ).toEqual({
      key: 'carryover:history.carriedOver',
      values: { source: '', target: '', date: '' },
    })
  })

  it('ignores non-string metadata values rather than printing them', () => {
    expect(
      carryoverActivityLabel({
        action: 'work_item.iteration_moved',
        changes: null,
        metadata: { sourceIterationName: 42, targetIterationName: { name: 'x' } },
      })?.values,
    ).toEqual({ source: '', target: '' })
  })

  it('returns null for every other action', () => {
    expect(carryoverActivityLabel({ action: 'work_item.updated', changes: null })).toBeNull()
    expect(carryoverActivityLabel({ action: 'work_item.split_in', changes: null })).toBeNull()
  })
})
