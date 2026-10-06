/**
 * The seam's own contract: `error` and `empty` must be DIFFERENT phases.
 *
 * Every one of these cases is a real shipped defect reduced to three lines. The one that matters
 * most is `returns phase "error", not "empty", for a failed request` — that single distinction is
 * what `data ?? []` destroyed at 158 call sites.
 */
import { describe, expect, it } from 'vitest'

import {
  combinePhase,
  emptyListResource,
  firstError,
  listResource,
  valueResource,
} from './resource'

const boom = new Error('boom')

describe('listResource', () => {
  it('hands out the SAME empty array on every call while there is no data (React 301 on US-120)', () => {
    // A fresh `[]` per render changed the reference `useRowRerank` re-syncs on during render, so a
    // Tasks / Test Cases tab mounted before its fetch resolved looped until React threw.
    const loading = listResource<number>({ data: undefined, isLoading: true })
    const again = listResource<number>({ data: undefined, isLoading: true })
    const failed = listResource<number>({ data: undefined, isError: true, error: boom })
    expect(again.rows).toBe(loading.rows)
    expect(failed.rows).toBe(loading.rows)
    // Shared, so it must not be writable by one caller on behalf of all the others.
    expect(Object.isFrozen(loading.rows)).toBe(true)
  })

  it('passes a real answer through by reference, including a measured empty one', () => {
    const data: number[] = []
    expect(listResource<number>({ data }).rows).toBe(data)
  })
  it('returns phase "loading" while the request is in flight, and no error', () => {
    const r = listResource<number>({ data: undefined, isLoading: true })
    expect(r.phase).toBe('loading')
    expect(r.rows).toEqual([])
    expect(r.isError).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('returns phase "error", NOT "empty", for a failed request', () => {
    // The whole point. `data` is `undefined` here exactly as it is while loading, and the old idiom
    // turned both into `[]` — so a 403 rendered "No artifacts linked to this release".
    const r = listResource<number>({ data: undefined, isError: true, error: boom })
    expect(r.phase).toBe('error')
    expect(r.phase).not.toBe('empty')
    expect(r.error).toBe(boom)
  })

  it('error OUTRANKS loading, so a failed refetch cannot sit on a skeleton for ever', () => {
    const r = listResource<number>({ data: undefined, isLoading: true, isError: true, error: boom })
    expect(r.phase).toBe('error')
    expect(r.isLoading).toBe(false)
  })

  it('returns phase "empty" only when the server actually answered with nothing', () => {
    const r = listResource<number>({ data: [], isLoading: false })
    expect(r.phase).toBe('empty')
    expect(r.isError).toBe(false)
  })

  it('returns phase "ready" with the rows when there are rows', () => {
    const r = listResource({ data: [1, 2, 3], isLoading: false })
    expect(r.phase).toBe('ready')
    expect(r.rows).toEqual([1, 2, 3])
  })

  it('prefers isLoading over isPending, so a query parked on a missing id is not a permanent skeleton', () => {
    // `isPending` is true for a DISABLED query (`enabled: false` while an id is undefined), which is
    // most of these hooks most of the time. Reading it alone would render every detail tab as
    // loading before its parent id resolved.
    const r = listResource<number>({ data: undefined, isLoading: false, isPending: true })
    expect(r.phase).toBe('empty')
    expect(r.isLoading).toBe(false)
  })
})

describe('valueResource', () => {
  it('separates "could not load" from "no such record"', () => {
    // The capacity-plan detail page printed "Capacity plan not found." for a 500 because it only
    // had `!plan` to test.
    expect(valueResource({ data: undefined, isError: true, error: boom }).phase).toBe('error')
    expect(valueResource({ data: undefined, isLoading: false }).phase).toBe('empty')
    expect(valueResource({ data: null, isLoading: false }).phase).toBe('empty')
    expect(valueResource({ data: { id: 'a' }, isLoading: false }).phase).toBe('ready')
  })

  it('never hands out a value in the error or loading phase', () => {
    expect(valueResource({ data: { id: 'a' }, isError: true, error: boom }).value).toBeUndefined()
    expect(valueResource({ data: { id: 'a' }, isLoading: true }).value).toBeUndefined()
  })
})

describe('combinePhase / firstError', () => {
  it('reports error when ANY part failed, even if another part is still loading', () => {
    const failed = listResource<number>({ data: undefined, isError: true, error: boom })
    const loading = listResource<number>({ data: undefined, isLoading: true })
    expect(combinePhase(failed, loading)).toBe('error')
    expect(firstError(loading, failed)).toBe(boom)
  })

  it('reports loading while any part is in flight and none failed', () => {
    const ready = listResource({ data: [1], isLoading: false })
    const loading = listResource<number>({ data: undefined, isLoading: true })
    expect(combinePhase(ready, loading)).toBe('loading')
    expect(firstError(ready, loading)).toBeUndefined()
  })

  it('reports ready when every part is settled', () => {
    expect(combinePhase(listResource({ data: [1], isLoading: false }))).toBe('ready')
  })
})

describe('emptyListResource', () => {
  it('satisfies a ListResource prop without claiming the server answered', () => {
    const r = emptyListResource<number>()
    expect(r.phase).toBe('empty')
    expect(r.isError).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('hands out the same frozen empty array as listResource, so it cannot restart the render loop', () => {
    // A fresh `[]` per call is the defect listResource just had: a caller building this during
    // render would change the `rows` reference every render and re-trigger `useRowRerank`'s sync.
    const a = emptyListResource<number>()
    const b = emptyListResource<number>()
    expect(b.rows).toBe(a.rows)
    expect(a.rows).toBe(listResource<number>({ data: undefined, isLoading: true }).rows)
    expect(Object.isFrozen(a.rows)).toBe(true)
  })
})
