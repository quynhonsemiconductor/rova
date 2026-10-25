/**
 * `carryoverActivityLabel` (Phase 7 CO-07) in isolation — PR #653 review.
 *
 * The Revision History tab test covers the rendered sentences; this pins the MAPPING, so a renamed
 * metadata key at the writer, or `metadata` dropped from the activity DTO, fails here instead of
 * silently rendering every entry as "Unscheduled".
 */
import { describe, expect, it } from 'vitest'

import { carryoverActivityLabel, describeActivity } from './activity'

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

describe('describeActivity — display values beside ids (SU-07 AC4, BA retest TC-51)', () => {
  it('renders the Story keys a Split captured, never the uuids', () => {
    expect(
      describeActivity({
        action: 'task.parent_changed',
        changes: { field: 'parentId', old: '0190-aaaa', new: '0190-bbbb' },
        metadata: { splitId: 's-1', oldName: 'US-7', newName: 'US-12' },
      }),
    ).toBe('Parent Story changed from US-7 to US-12')
  })

  it('renders Iteration names on the [Continued] diff', () => {
    expect(
      describeActivity({
        action: 'work_item.updated',
        changes: { field: 'iterationId', old: 'it-1', new: 'it-2' },
        metadata: { splitId: 's-1', oldName: 'Sprint 1', newName: 'Sprint 2' },
      }),
    ).toBe('Iteration Id changed from Sprint 1 to Sprint 2')
  })

  it('keeps a blank side "(empty)" and falls back to the value without a name', () => {
    expect(
      describeActivity({
        action: 'work_item.updated',
        changes: { field: 'releaseId', old: null, new: 'rel-1' },
        metadata: { oldName: null, newName: 'R1' },
      }),
    ).toBe('Release Id changed from (empty) to R1')
    expect(
      describeActivity({
        action: 'work_item.updated',
        changes: { field: 'title', old: 'A', new: 'B' },
      }),
    ).toBe('Title changed from A to B')
  })
})
