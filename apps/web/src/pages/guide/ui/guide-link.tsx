import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/shared/lib/utils'
import { useGuide } from './guide-context'

interface GuideLinkProps {
  /** Chapter slug; omitted for a section of the chapter on screen. */
  to?: string
  /** Section id to land on. */
  hash?: string
  className?: string
  children: ReactNode
}

/**
 * A link inside the guide, in the edition being read.
 *
 * The static guide linked `NN-slug.html#anchor` and needed `guide.js` to rewrite same-page links and
 * to work around Pages stripping `.html`. A route link needs neither: it is client-side, keeps the
 * language, and `useScrollToHash` lands it on the section once the chapter has rendered.
 */
export function GuideLink({ to, hash, className, children }: GuideLinkProps) {
  const { lang, chapter } = useGuide()
  return (
    <Link
      to="/user-guide/$lang/$chapter"
      params={{ lang, chapter: to ?? chapter }}
      hash={hash}
      className={cn('text-primary-light underline-offset-4 hover:underline', className)}
    >
      {children}
    </Link>
  )
}
