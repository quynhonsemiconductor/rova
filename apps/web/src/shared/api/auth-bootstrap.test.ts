import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapAuth, resetAuthBootstrap, retryAuthBootstrap } from './auth-bootstrap'
import { useAuthStore } from '@/shared/lib/stores/auth.store'
import { getCsrfToken, setCsrfToken } from './csrf'

const ME = {
  id: 'u-1',
  email: 'alice@qnsc.dev',
  displayName: 'Alice',
  locale: 'en',
  timezone: 'UTC',
  role: 'project_member',
  permissions: ['work_item:view'],
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  csrfToken: 'csrf-1',
  memberships: [],
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const resetStore = () =>
  useAuthStore.setState({
    user: null,
    memberships: [],
    activeWorkspaceId: null,
    isAuthenticated: false,
    isLoading: true,
    isSwitchingWorkspace: false,
    authError: null,
  })

describe('bootstrapAuth', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    resetAuthBootstrap()
    resetStore()
    fetchMock.mockReset()
    setCsrfToken(null)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetAuthBootstrap()
  })

  it('401 CLEARS the session: the cookie is dead, so sign-in is the way back', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }))

    await bootstrapAuth()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().authError).toBeNull()
  })

  it('403 is NOT a session fact: /auth/me is self-scoped, so a 403 comes from in front of the route', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'FORBIDDEN' } }))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(10_000)
    await done

    // Retried like any transient failure, and the store is left alone rather than cleared.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(useAuthStore.getState().authError).toBe('unavailable')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('429 does NOT clear; it waits Retry-After and retries, then restores the session', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '2' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, ME))

    const done = bootstrapAuth()
    // The promise is pending while the retry delay runs: not signed out, not failed.
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().authError).toBeNull()

    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().user?.id).toBe('u-1')
    expect(getCsrfToken()).toBe('csrf-1')
  })

  it('a 5xx exhausts the retries and shows the recovery screen, never signing the user out', async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, { error: { code: 'BAD_GATEWAY' } }))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(10_000)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(useAuthStore.getState().authError).toBe('unavailable')
    expect(useAuthStore.getState().isLoading).toBe(false)
    // No session fact was established, so nothing was cleared and no CSRF token was invented.
    expect(getCsrfToken()).toBeNull()
  })

  it('a network failure is retried too, and succeeds on the second attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, ME))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(500)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().authError).toBeNull()
  })

  it('an ABORTED attempt is transient and retried, and every attempt carries a timeout signal', async () => {
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(jsonResponse(200, ME))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(500)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)

    const options = fetchMock.mock.calls[0][1] as { signal?: unknown }
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports unavailable, not restored, when a kept profile could not be reached', async () => {
    useAuthStore.setState({
      user: { ...ME },
      memberships: [],
      isAuthenticated: true,
      isLoading: false,
      authError: null,
    })
    fetchMock.mockResolvedValue(jsonResponse(503, { error: {} }))

    const outcome = retryAuthBootstrap()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(outcome).resolves.toBe('unavailable')
    expect(useAuthStore.getState().user?.id).toBe('u-1')
  })

  it('a 200 with a malformed body fails RECOVERABLY: the promise resolves, the screen shows', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))

    await expect(bootstrapAuth()).resolves.toBeUndefined()

    expect(useAuthStore.getState().authError).toBe('unavailable')
    expect(useAuthStore.getState().isLoading).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a signed-in profile SURVIVES a transient outage: 5xx does not sign the user out', async () => {
    useAuthStore.setState({
      user: { ...ME },
      memberships: [],
      isAuthenticated: true,
      isLoading: false,
      authError: null,
    })
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { code: 'UNAVAILABLE' } }))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(10_000)
    await done

    expect(useAuthStore.getState().user?.id).toBe('u-1')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().authError).toBe('unavailable')
  })

  it('retryAuthBootstrap re-runs a failed bootstrap and succeeds once the server recovers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}, { 'retry-after': '1' }))
    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(useAuthStore.getState().authError).toBe('unavailable')

    fetchMock.mockResolvedValue(jsonResponse(200, ME))
    const restored = retryAuthBootstrap()
    await vi.runAllTimersAsync()
    await expect(restored).resolves.toBe('restored')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().authError).toBeNull()
  })

  it('retryAuthBootstrap reports a GENUINELY dead session as signedOut', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }))

    await expect(retryAuthBootstrap()).resolves.toBe('signedOut')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().authError).toBeNull()
  })

  it('retryAuthBootstrap JOINS a run already in flight instead of starting a second', async () => {
    let release!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )

    const first = bootstrapAuth()
    const retry = retryAuthBootstrap()
    release(jsonResponse(200, ME))

    await expect(first).resolves.toBeUndefined()
    await expect(retry).resolves.toBe('restored')
    // One request: the retry awaited the run that was already going.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never latches a REJECTED promise: an unexpected throw becomes the recovery screen', async () => {
    const evil = { ...ME }
    Object.defineProperty(evil, 'memberships', {
      get() {
        throw new Error('unexpected shape')
      },
    })
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => evil,
    } as unknown as Response)

    await expect(bootstrapAuth()).resolves.toBeUndefined()
    expect(useAuthStore.getState().authError).toBe('unavailable')
    expect(useAuthStore.getState().isLoading).toBe(false)
  })

  it('caps a Retry-After the server asks for beyond the ceiling', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '3600' }))
      .mockResolvedValueOnce(jsonResponse(200, ME))

    const done = bootstrapAuth()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
