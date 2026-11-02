import { useTranslation } from 'react-i18next'
import { BRAND } from '@/shared/config/brand'
import type { StatusStyle } from '@/shared/config/status-colors'
import { StatusBadge } from '@/shared/ui/status-badge'

type RecordType = 'testCase' | 'testResult'

/**
 * The text chip a Test Case / Test Result detail header leads with (SRS §6.1, §9.1: "The header
 * shows Test Case badge, ID and Name" / "Test Result badge, Result ID and Build"; US-93 TC-23,
 * US-97 TC-35).
 *
 * A WORD rather than `TypeBadge`'s round glyph, because that is what the mockup draws and because
 * the two records share one key shape on screen (`TC-12` beside `TR-12`) — a reader one click into
 * the Work Item → Test Case → Test Result chain needs the header to say which of the two it is.
 * Colours follow the mockup: green for the Test Case, blue for the Result.
 */
const STYLE: Record<RecordType, Omit<StatusStyle, 'label'>> = {
  testCase: { bg: BRAND.successBg, text: BRAND.success, border: BRAND.successBorder },
  testResult: { bg: BRAND.accentBg, text: BRAND.primaryLight, border: BRAND.accentBorder },
}

export function RecordTypeBadge({ type }: { type: RecordType }) {
  const { t } = useTranslation('test-cases')
  return <StatusBadge style={{ ...STYLE[type], label: t(`recordType.${type}`) }} />
}
