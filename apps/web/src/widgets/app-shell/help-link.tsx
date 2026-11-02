import { Link } from '@tanstack/react-router'
import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/shared/ui/icon-button'

/**
 * The top bar's Help icon: opens the User Guide (US-119) in the SAME tab, like any other page, so Back
 * returns the reader to where they were (BA, 2026-10-30, reversing AC1's new tab).
 *
 * The link names no edition. `/user-guide` chooses one itself — from the browser language
 * (`pages/guide/model/guide-url.ts`, which this widget layer cannot import) — EXCEPT when the reader
 * is already in the guide: `params={true}` keeps the current route's `lang`, so Help from the English
 * guide stays in English rather than jumping to the browser's edition. No other route has a `lang`.
 *
 * A router link rather than a click handler, so middle-click and "Open in new tab" still work.
 */
export function HelpLink() {
  const { t } = useTranslation('nav')

  return (
    <IconButton
      asChild
      size="lg"
      aria-label={t('help.openGuide')}
      // The top bar is always dark. Hover surface matches `ActionMenu`'s `onDark` (`hover:bg-white/10`);
      // the resting ink is the top bar's 65% white (Notifications/Settings), reaching full white on hover.
      className="text-white/65 hover:bg-white/10 hover:text-white"
    >
      <Link to="/user-guide/{-$lang}" params={true}>
        <HelpCircle size={14} aria-hidden="true" />
      </Link>
    </IconButton>
  )
}
