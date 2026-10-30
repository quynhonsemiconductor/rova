import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/** Where the guide's screenshots are served. Gated by `functions/guide-assets/_middleware.ts`. */
export const GUIDE_ASSETS_ROOT = '/guide-assets/'

interface GuideShotProps {
  /** File name under `public/guide-assets/`, without `.png`. */
  name: string
  alt: string
  caption?: ReactNode
  className?: string
}

/**
 * A production screenshot.
 *
 * Deliberately NOT imported into the bundle: Vite would publish it under `/assets/`, which is
 * public. The guide's text is fine in a public chunk; its screenshots show production data, so they
 * stay behind the session gate at `/guide-assets/` and are referenced by URL.
 */
export function GuideShot({ name, alt, caption, className }: GuideShotProps) {
  return (
    <figure
      className={cn(
        'my-7 overflow-hidden rounded-lg border border-border-strong bg-card',
        className,
      )}
    >
      <img
        src={`${GUIDE_ASSETS_ROOT}${name}.png`}
        alt={alt}
        loading="lazy"
        className="block h-auto w-full"
      />
      {caption && (
        <figcaption className="border-t border-border-subtle bg-surface-subtle px-3 py-2.5 text-doc-sm text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
