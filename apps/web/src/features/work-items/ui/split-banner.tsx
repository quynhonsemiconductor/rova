/**
 * The Split banner — `Split · {Source} → {Target}`, with a link to each resulting Story.
 *
 * SU-07 7.2 / SRS §11 / SU-BR-30. It renders on BOTH Story Details, from the same `splitLink` the
 * record read now carries, so the two sides cannot describe the split differently.
 *
 * **NO EXPLANATORY SENTENCE.** SRS §11 asks for a compact bar and nothing else — no "this story was
 * split because…", no warning, no toast. That absence is asserted in the spec, because adding a
 * helpful sentence is exactly the kind of change that feels like an improvement.
 *
 * **The current side is TEXT, the counterpart is a LINK.** `role` tells us which Story the reader is
 * already on, and offering a link back to the page you are standing on is an affordance that does
 * nothing. Both keys are still shown, so the pair is legible from either side.
 *
 * Router `Link`, never `window.location` (7.3): a full page load would drop the query cache and the
 * scroll position for a navigation inside the same SPA. No copy affordance here — if one is ever
 * wanted it comes from `@/shared/lib/entity-link`, which the `detail-copy-link` ratchet enforces.
 */
import { Link } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SplitLink } from '@/features/work-items/split-api'
import { EMPTY_VALUE } from '@/shared/lib/utils'

/** One end of the pair: a link to the counterpart, or plain text for the Story being viewed. */
function SplitEnd({
  itemKey,
  title,
  label,
  linkLabel,
  isCurrent,
}: {
  itemKey: string
  title: string
  label: string
  linkLabel: string
  isCurrent: boolean
}) {
  if (isCurrent) {
    // `aria-current="page"` rather than a disabled link: the relationship is still stated, and a
    // screen reader is told which of the two it is on.
    return (
      <span aria-current="page" className="font-mono font-semibold text-foreground">
        {label}
      </span>
    )
  }

  return (
    <Link
      to="/item/$itemKey"
      params={{ itemKey }}
      // The accessible name carries the TITLE as well as the key: `US-42` alone tells a screen-reader
      // user nothing about where the link goes, and the visible label has no room for both.
      aria-label={linkLabel}
      title={title}
      className="font-mono text-primary-light underline-offset-2 hover:underline"
    >
      {label}
    </Link>
  )
}

export function SplitBanner({ splitLink }: { splitLink: SplitLink }) {
  const { t } = useTranslation('split-story')
  const onUnfinished = splitLink.role === 'unfinished'

  return (
    <section
      aria-label={t('banner.region')}
      // Info tone from the token set — no raw hex anywhere (`no-raw-hex` is 0).
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-accent-border bg-accent-bg-subtle px-3 py-2 text-ui-sm text-foreground"
    >
      <GitBranch size={14} className="text-primary-light" aria-hidden="true" />
      <span className="font-semibold">{t('banner.label')}</span>
      <span aria-hidden="true">·</span>
      {/* The iteration names, and `--` for a name the join could not resolve: a deleted sprint must
          degrade the bar rather than delete the trace, and an absent name is not an empty string. */}
      <span>{splitLink.sourceIterationName ?? EMPTY_VALUE}</span>
      <span aria-hidden="true">{t('banner.arrow')}</span>
      <span>{splitLink.targetIterationName ?? EMPTY_VALUE}</span>
      <span aria-hidden="true">·</span>
      <SplitEnd
        itemKey={splitLink.unfinished.itemKey}
        title={splitLink.unfinished.title}
        label={t('banner.unfinished', { key: splitLink.unfinished.itemKey })}
        linkLabel={t('banner.openUnfinished', {
          key: splitLink.unfinished.itemKey,
          title: splitLink.unfinished.title,
        })}
        isCurrent={onUnfinished}
      />
      <span aria-hidden="true">·</span>
      <SplitEnd
        itemKey={splitLink.continued.itemKey}
        title={splitLink.continued.title}
        label={t('banner.continued', { key: splitLink.continued.itemKey })}
        linkLabel={t('banner.openContinued', {
          key: splitLink.continued.itemKey,
          title: splitLink.continued.title,
        })}
        isCurrent={!onUnfinished}
      />
    </section>
  )
}
