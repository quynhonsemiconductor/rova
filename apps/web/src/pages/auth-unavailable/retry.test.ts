import { afterEach, describe, expect, it, vi } from 'vitest'
import { retrySession, safeReturnTo } from './retry'
import { retryAuthBootstrap } from '@/shared/api/auth-bootstrap'

vi.mock('@/shared/api/auth-bootstrap', () => ({
  retryAuthBootstrap: vi.fn(),
}))

describe('safeReturnTo', () => {
  it.each([
    ['/projects?x=1', '/projects?x=1'],
    ['/backlog#top', '/backlog#top'],
    // Obfuscated protocol-relative forms: browsers parse these as another origin.
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['/%5Cevil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['https://evil.example/x', '/'],
    ['/login', '/login'],
  ])('%j -> %j', (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected)
  })

  it('treats a missing value as the root', () => {
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
  })
})

describe('retrySession', () => {
  afterEach(() => vi.mocked(retryAuthBootstrap).mockReset())

  it('returns to the original page when the session comes back', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue('restored')
    const navigate = vi.fn()
    await expect(retrySession('?returnTo=%2Fbacklog%3Fx%3D1', navigate)).resolves.toBe('restored')
    expect(navigate).toHaveBeenCalledWith('/backlog?x=1')
  })

  it('sends a DEAD session to /login with the same returnTo, exactly like the router', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue('signedOut')
    const navigate = vi.fn()
    await expect(retrySession('?returnTo=%2Fbacklog%3Fx%3D1', navigate)).resolves.toBe('signedOut')
    expect(navigate).toHaveBeenCalledWith('/login?returnTo=%2Fbacklog%3Fx%3D1')
  })

  it('goes to bare /login when there was no return target', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue('signedOut')
    const navigate = vi.fn()
    await retrySession('', navigate)
    expect(navigate).toHaveBeenCalledWith('/login')
  })

  it('stays put while the answer is unavailable: nothing navigates', async () => {
    vi.mocked(retryAuthBootstrap).mockResolvedValue('unavailable')
    const navigate = vi.fn()
    await expect(retrySession('?returnTo=%2Fbacklog', navigate)).resolves.toBe('unavailable')
    expect(navigate).not.toHaveBeenCalled()
  })
})
