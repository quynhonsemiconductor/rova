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
 * public. Screenshots show production data, so they sit behind the session gate at `/guide-assets/`
 * — like the chunks carrying the guide's text — and are referenced by URL.
 *
 * The gate is the one part of the guide that can refuse — an expired session gets a redirect, which
 * an `<img>` cannot decode — so a failed load says so in words instead of showing a broken image.
 */
export function GuideShot({ name, alt, caption, narrow = false, className }: GuideShotProps) {
  const { lang } = useGuide()
  const { t } = useTranslation('guide', { lng: lang })
  // Which file failed, not just "failed": a reused instance handed another screenshot tries it.
  const [failedName, setFailedName] = useState<GuideShotName>()
  const failed = failedName === name
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
        // Plain text, not `role="img"`: that role makes its children presentational, so a screen
        // reader would hear the alt and never the sentence this fallback exists to say.
        <div className="flex items-center gap-3 bg-surface-subtle px-4 py-6 text-ui-md text-muted-foreground">
          <ImageOff size={20} aria-hidden="true" className="shrink-0" />
          <p>
            {t('shotUnavailable')} <span className="sr-only">{alt}</span>
          </p>
        </div>
      ) : (
        <img
          src={`${GUIDE_ASSETS_ROOT}${name}.png`}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          onError={() => setFailedName(name)}
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
