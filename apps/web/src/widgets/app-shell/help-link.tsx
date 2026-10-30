import { Link } from '@tanstack/react-router'
import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/shared/ui/icon-button'

/**
 * The top bar's Help icon: opens the User Guide (US-119) as a page of the app, in the SAME tab.
 *
 * It used to open the standalone HTML guide in a new tab (US-119 AC1). The guide is now the
 * `/user-guide` route, and the BA confirmed (2026-10-30) that Help navigates to it in place, like any
 * other page — Back returns the reader to where they were. `/user-guide` picks the edition from the
 * browser language itself (`pages/guide/model/guide-url.ts`), which this widget layer cannot import.
 *
 * A router link rather than a click handler, so middle-click and "Open in new tab" still work for a
 * reader who wants the guide beside their work.
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
      <Link to="/user-guide/{-$lang}" params={{}}>
        <HelpCircle size={14} aria-hidden="true" />
      </Link>
    </IconButton>
  )
}
