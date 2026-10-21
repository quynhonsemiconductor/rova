/**
 * Report a defect that degrades silently — a record link that lost its URL — ONCE per key for the
 * whole SESSION (the Set is module-level and survives route changes in this SPA), not once per cell: one mis-built path helper feeding a 50-row grid is one defect, and
 * 50 identical errors would bury real ones. A warning in development (an authoring hint), an error
 * in production (a defect someone should see).
 */
const reported = new Set<string>()

export function reportOnce(key: string, message: string): void {
  if (reported.has(key)) return
  reported.add(key)
  if (import.meta.env.DEV) console.warn(message)
  else console.error(message)
}
