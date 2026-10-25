import { ENV } from '@/shared/config/env'

/**
 * Report a defect that degrades silently — a record link that lost its URL — ONCE per key for the
 * whole SESSION (the Set is module-level and survives route changes in this SPA), not once per cell: one mis-built path helper feeding a 50-row grid is one defect, and
 * 50 identical errors would bury real ones. A warning in development (an authoring hint), an error
 * in production (a defect someone should see).
 */
const reported = new Set<string>()

// A KEY must name the defect's SHAPE, from a bounded set (a record type, a URL's kind), never a
// per-record value such as an id or the URL itself: a key carrying identity would report — and keep
// a Set entry — once per row, the very noise this module exists to prevent.

export function reportOnce(key: string, message: string): void {
  if (reported.has(key)) return
  reported.add(key)
  if (ENV.IS_DEV) console.warn(message)
  else console.error(message)
}

/** Tests only: forget what was reported, so each test starts from a clean session. */
export function resetReportedForTests(): void {
  reported.clear()
}
