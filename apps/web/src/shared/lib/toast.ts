import { toast as sonner } from 'sonner'

/**
 * Rova's toast facade over `sonner`.
 *
 * Pages should import `notify` from here rather than `toast` from 'sonner'
 * directly, so toast copy/format/variants stay consistent from one place and
 * the error-unwrapping boilerplate (`err instanceof Error ? err.message : …`,
 * which was repeated ~a dozen times across pages) lives in exactly one spot.
 *
 * The <Toaster /> itself is mounted once in app/providers/app-providers.tsx.
 */

/** Unwrap a thrown value into a human-readable message. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return fallback
}

export const notify = {
  success: (message: string, description?: string) => sonner.success(message, { description }),
  error: (message: string, description?: string) => sonner.error(message, { description }),
  info: (message: string, description?: string) => sonner.info(message, { description }),
  warning: (message: string, description?: string) => sonner.warning(message, { description }),
  /**
   * Show an error toast built from a thrown value, unwrapping Error/string.
   * Replaces the repeated `toast.error(err instanceof Error ? err.message : '…')`.
   */
  fromError: (err: unknown, fallback?: string) => sonner.error(errorMessage(err, fallback)),
}
