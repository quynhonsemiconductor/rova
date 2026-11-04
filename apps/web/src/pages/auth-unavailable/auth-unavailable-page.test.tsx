import '@/shared/i18n/i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthUnavailablePage } from './auth-unavailable-page'
import { retrySession } from './retry'

vi.mock('./retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry')>()
  return { ...actual, retrySession: vi.fn() }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AuthUnavailablePage', () => {
  afterEach(() => vi.mocked(retrySession).mockReset())

  it('retries IN PLACE: the button shows progress and comes back when the answer is unavailable', async () => {
    const pending = deferred<'unavailable'>()
    vi.mocked(retrySession).mockReturnValue(pending.promise)
    render(<AuthUnavailablePage />)

    const button = screen.getByRole('button', { name: /try again/i })
    fireEvent.click(button)

    const retryMock = vi.mocked(retrySession)
    expect(retryMock).toHaveBeenCalledTimes(1)
    expect(retryMock.mock.calls[0][0]).toBe(window.location.search)
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled())

    pending.resolve('unavailable')
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled())
  })

  it('leaves the screen when the session is restored or signed out (navigation lives in retrySession)', async () => {
    vi.mocked(retrySession).mockResolvedValue('restored')
    render(<AuthUnavailablePage />)

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => expect(retrySession).toHaveBeenCalledTimes(1))
    // 'restored' navigates inside retrySession; the page does not re-enable its own button.
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled())
  })

  it('a rejected retry is logged and the button comes back', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(retrySession).mockRejectedValue(new Error('boom'))
    render(<AuthUnavailablePage />)

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled())
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
