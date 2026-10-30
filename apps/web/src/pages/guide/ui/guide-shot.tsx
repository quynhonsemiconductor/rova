import { useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { GUIDE_SHOTS, type GuideShotName } from '../model/shots'
import { useGuide } from './guide-context'

/** Where the guide's screenshots are served. Gated by `functions/guide-assets/_middleware.ts`. */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'

interface GuideShotProps {
  /** File name under `public/guide-assets/`, without `.png`. */
  name: GuideShotName
  alt: string
  caption?: ReactNode
  /** For a tall, narrow capture (a dropdown) that would blur if stretched to the column. */
  narrow?: boolean
  className?: string
}

/**
 * A production screenshot.
 *
 * Deliberately NOT imported into the bundle: Vite would publish it under `/assets/`, which is
 * public. The guide's text is fine in a public chunk; its screenshots show production data, so they
 * stay behind the session gate at `/guide-assets/` and are referenced by URL.
 *
 * The gate is the one part of the guide that can refuse — an expired session gets a redirect, which
 * an `<img>` cannot decode — so a failed load says so in words instead of showing a broken image.
 */
export function GuideShot({ name, alt, caption, narrow = false, className }: GuideShotProps) {
  const { lang } = useGuide()
  const { t } = useTranslation('guide', { lng: lang })
  const [failed, setFailed] = useState(false)
  const { width, height } = GUIDE_SHOTS[name]

  return (
    <figure
      className={cn(
        'my-7 overflow-hidden rounded-lg border border-border-strong bg-card',
        narrow && 'max-w-sm',
        className,
      )}
    >
      {failed ? (
        <div
          role="img"
          aria-label={alt}
          className="flex items-center gap-3 bg-surface-subtle px-4 py-6 text-ui-md text-muted-foreground"
        >
          <ImageOff size={20} aria-hidden="true" className="shrink-0" />
          {t('shotUnavailable')}
        </div>
      ) : (
        <img
          src={`${GUIDE_ASSETS_ROOT}${name}.png`}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block h-auto w-full"
        />
      )}
      {caption && (
        <figcaption className="border-t border-border-subtle bg-surface-subtle px-3 py-2.5 text-doc-sm text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
