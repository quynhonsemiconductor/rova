import { HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/shared/ui/icon-button'
import { guideUrlFor } from './model/guide-url'

/**
 * The top bar's Help icon: opens the official User Guide (US-119) in a new tab, in the reader's
 * browser language.
 *
 * A real link rather than a `window.open` handler, so middle-click, "Open in new tab", keyboard Enter
 * and screen readers all treat it as the navigation it is, and no popup blocker can swallow it. The
 * current Rova tab is never navigated (AC1). `noopener noreferrer` keeps the guide tab from reaching
 * back into this one through `window.opener`.
 *
 * The guide itself is gated server-side (`functions/_lib/guide-gate.ts`); this link is not a control.
 */
export function HelpLink() {
  const { t } = useTranslation('nav')
  const label = t('help.openGuide')

  return (
    <IconButton
      asChild
      size="lg"
      aria-label={label}
      // The top bar is always dark — the same on-dark treatment `ActionMenu`'s `onDark` uses.
      className="text-white/65 hover:bg-white/10 hover:text-white"
    >
      <a
        href={guideUrlFor(navigator.languages ?? [navigator.language])}
        target="_blank"
        rel="noopener noreferrer"
      >
        <HelpCircle size={14} aria-hidden="true" />
      </a>
    </IconButton>
  )
}
