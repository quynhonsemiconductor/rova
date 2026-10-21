import { useEffect } from 'react'
import { reportOnce } from '@/shared/lib/report-once'
import { recordHrefProblem, resolveRecordHref } from './record-href'

/**
 * The URL an ID / reference cell renders (`resolveRecordHref`), and — from an EFFECT, so render
 * stays pure, the same rule `RecordOpener` follows — a once-per-session report when a cell that
 * should have a URL got none (`recordHrefProblem`). `enabled: false` for a read-only cell, which
 * ignores the URL anyway and so has nothing to report.
 */
export function useRecordHref({
  href,
  type,
  itemKey,
  recordId,
  enabled,
}: {
  href: string | undefined
  type: string
  itemKey: string
  recordId?: string
  enabled: boolean
}): string | undefined {
  const problem = enabled && !href ? recordHrefProblem(type, recordId) : undefined
  const problemKey = problem?.key
  const problemMessage = problem?.message
  useEffect(() => {
    if (problemKey && problemMessage) reportOnce(problemKey, problemMessage)
  }, [problemKey, problemMessage])
  // An explicit `href` is authoritative whatever `enabled` says; `enabled` only mutes the DERIVED
  // URL and its report. Delegates to `resolveRecordHref`, the one copy of the `href || derived` rule.
  return enabled ? resolveRecordHref(href, type, itemKey, recordId) : href || undefined
}
