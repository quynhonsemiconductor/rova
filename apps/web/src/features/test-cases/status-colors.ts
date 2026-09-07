import { BRAND } from '@/shared/config/brand'
import type { StatusStyle } from '@/shared/config/status-colors'
import type { TestCase } from './api'

type TestVerdict = NonNullable<TestCase['lastVerdict']>

/**
 * Test verdict → badge colours, same shape as `TEAM_STATUS_STYLE`. Every enum member has a style
 * (BR9/BR10) — the text carries the meaning, never colour alone: `fail` and `error` both read
 * danger-red but say different words, and `blocked` / `inconclusive` are both amber for the same
 * reason (neither is a pass or a fail, and the READER decides which matters).
 */
export const TEST_VERDICT_STYLE: Record<TestVerdict, StatusStyle> = {
  pass: { bg: BRAND.successBg, text: BRAND.success, border: BRAND.successBorder, label: 'Pass' },
  fail: { bg: BRAND.dangerBg, text: BRAND.danger, border: BRAND.dangerBorder, label: 'Fail' },
  blocked: {
    bg: BRAND.warningBg,
    text: BRAND.warning,
    border: BRAND.warningBorder,
    label: 'Blocked',
  },
  error: { bg: BRAND.dangerBg, text: BRAND.danger, border: BRAND.dangerBorder, label: 'Error' },
  inconclusive: {
    bg: BRAND.warningBg,
    text: BRAND.warning,
    border: BRAND.warningBorder,
    label: 'Inconclusive',
  },
  not_run: {
    bg: BRAND.primaryLighter,
    text: BRAND.textSecondary,
    border: BRAND.border,
    label: 'Not Run',
  },
}
