/**
 * Extracts a human-readable message from an openapi-fetch error body.
 * The BE wraps all errors as: { error: { code, message, ... } }
 *
 * Single source of truth — import this in every feature API module instead
 * of duplicating the extraction logic.
 */
export function apiErrorMessage(error: unknown, status?: number): string {
  let message: string | undefined
  let correlationId: string | undefined
  if (error && typeof error === 'object') {
    // BE error envelope: { error: { code, message, correlationId, ... } }
    const nested = (error as { error?: { message?: string; correlationId?: string } }).error
    if (nested) {
      if (nested.message) message = nested.message
      if (nested.correlationId) correlationId = nested.correlationId
    }
    // Fallback: flat { message } shape
    if (!message) {
      const msg = (error as { message?: string }).message
      if (msg && typeof msg === 'string') message = msg
    }
  }
  const base = message ?? `Request failed (${status})`
  // Surface the server trace id for unexpected / server-side failures so support
  // can grep logs by reference. 4xx messages are self-explanatory and omit it.
  if (correlationId && (status === undefined || status >= 500)) {
    return `${base} (ref: ${correlationId})`
  }
  return base
}

/**
 * The stable domain CODE from the same envelope — for the callers that must BRANCH, not print.
 *
 * `apiErrorMessage` above is for display, and a surface that has to react DIFFERENTLY to two
 * refusals cannot be built on it: the message is prose the BE may reword, while the code is the
 * contract (`libs/platform`'s domain exceptions all carry one, and `ErrorCode` is a union). Reading
 * the code is what lets `/accept-invitation` say "you are signed in as the wrong account" for
 * `INVITATION_EMAIL_MISMATCH` and "ask for a new invitation" for `INVITATION_EXPIRED`, instead of
 * one generic failure for both.
 *
 * Accepts BOTH shapes on purpose: the raw openapi-fetch error body `{ error: { code } }`, and an
 * {@link ApiError} that a feature hook has already thrown (its own `code` property). A caller in a
 * mutation's `onError` only ever sees the latter — the raw body is gone by then — so a helper that
 * handled only one of the two would silently return `undefined` at exactly the call site that needs
 * it.
 */
export function apiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const nested = (error as { error?: { code?: unknown } }).error
  if (nested && typeof nested === 'object' && typeof nested.code === 'string') return nested.code
  const flat = (error as { code?: unknown }).code
  return typeof flat === 'string' ? flat : undefined
}

/**
 * An `Error` that CARRIES the envelope's code, so a mutation's `onError` can still branch on it.
 *
 * The repo's feature hooks throw `new Error(apiErrorMessage(error, status))`, which is right for
 * every surface that only prints the message — but it discards the code, and TanStack Query hands
 * `onError` nothing but the thrown value. Throw this instead wherever a caller branches; the message
 * is identical, so nothing that only reads `error.message` changes.
 */
export class ApiError extends Error {
  /** The BE's stable domain code (`INVITATION_EXPIRED`, …), or `undefined` for a transport failure. */
  readonly code: string | undefined
  /** The HTTP status, kept for the rare caller that needs 4xx-vs-5xx. */
  readonly status: number | undefined
  /** A 429's `Retry-After`, in seconds. The query client's retry policy waits this long. */
  readonly retryAfter: number | undefined

  constructor(error: unknown, status?: number, retryAfter?: number) {
    super(apiErrorMessage(error, status))
    this.name = 'ApiError'
    this.code = apiErrorCode(error)
    this.status = status
    this.retryAfter = retryAfter
  }
}
