/** The persisted-iteration key owner (PR 653 review): one spelling, and a write that cannot throw. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from '@/shared/config/storage-keys'
import { lastAccessedIterationKey, rememberIteration } from './use-selected-iteration'

describe('rememberIteration', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes under the one key the hook reads', () => {
    rememberIteration('p1', 'it-9')
    expect(lastAccessedIterationKey('p1')).toBe(`${STORAGE_KEYS.LAST_ACCESSED_ITERATION}:p1`)
    expect(localStorage.getItem(lastAccessedIterationKey('p1'))).toBe('it-9')
  })

  it('swallows a storage failure (Safari private mode, full quota) instead of aborting the caller', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => rememberIteration('p1', 'it-1')).not.toThrow()
  })
})
