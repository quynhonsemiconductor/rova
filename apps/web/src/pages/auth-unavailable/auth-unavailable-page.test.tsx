import { describe, expect, it, vi } from 'vitest'
import { retrySession, safeReturnTo } from './retry'

vi.mock('@/shared/api/auth-bootstrap', () => ({
  retryAuthBootstrap: vi.fn(),
}))

import { retryAuthBootstrap } from '@/shared/api/auth-bootstrap'

describe('auth-unavailable recovery', () => {
  it('only accepts a same-origin absolute path as the return target', () => {
    expect(safeReturnTo('/backlog?x=1')).toBe('/backlog?x=1')
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
    expect(safeReturnTo('//evil.example')).toBe('/')
    expect(safeReturnTo('https://evil.example')).toBe('/')
    expect(safeReturnTo('backlog')).toBe('/')
  })

  it('navigates back to the page the reader was on after bootstrap succeeds', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue(true)
    const navigate = vi.fn()

    await expect(retrySession('?returnTo=%2Fbacklog%3Fx%3D1', navigate)).resolves.toBe(true)

    expect(retryAuthBootstrap).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/backlog?x=1')
  })

  it('does NOT navigate when the retry fails: the recovery screen stays', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue(false)
    const navigate = vi.fn()

    await expect(retrySession('?returnTo=%2Fbacklog', navigate)).resolves.toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
