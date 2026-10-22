import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { usePendingPatch } from './use-pending-patch'

describe('usePendingPatch', () => {
  it('stages edits over the entity and reports dirty', () => {
    const { result } = renderHook(() =>
      usePendingPatch({ a: 1, b: 'x' }, 'id-1', vi.fn().mockResolvedValue(undefined)),
    )
    act(() => result.current.setField({ b: 'y' }))
    expect(result.current.value).toEqual({ a: 1, b: 'y' })
    expect(result.current.isDirty).toBe(true)
  })

  it('drops a field set to undefined, so the entity value shows again and the form is clean', () => {
    const { result } = renderHook(() =>
      usePendingPatch<{ a: number; b: string }>({ a: 1, b: 'x' }, 'id-1', vi.fn()),
    )
    act(() => result.current.setField({ b: 'y' }))
    act(() => result.current.setField({ b: undefined }))
    expect(result.current.value).toEqual({ a: 1, b: 'x' })
    expect(result.current.isDirty).toBe(false)
  })
})
