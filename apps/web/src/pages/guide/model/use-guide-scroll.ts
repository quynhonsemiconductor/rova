import { useEffect, useState, type RefObject } from 'react'

/**
 * Land on the URL's section once the chapter has rendered, or at the top for a chapter with none.
 *
 * Chapters are lazy, so at navigation time the target id does not exist yet and the router cannot
 * scroll to it. Call this from a component rendered INSIDE the chapter's `Suspense` boundary: its
 * effect then runs only after the chapter's DOM is committed.
 */
export function useScrollToHash(
  container: RefObject<HTMLElement | null>,
  chapter: string,
  hash: string,
) {
  useEffect(() => {
    const target = hash ? document.getElementById(hash) : null
    if (target) target.scrollIntoView({ block: 'start' })
    else container.current?.scrollTo({ top: 0 })
  }, [container, chapter, hash])
}

/** How far below the top of the reading pane a section's heading counts as "being read". */
const READING_LINE_PX = 120

/**
 * The id of the section being read: the last of `ids` whose top has scrolled above the reading
 * line. Drives the sidebar highlight, as `guide.js` did on scroll — but without rewriting the URL,
 * which would turn every scroll into a router navigation.
 */
export function useActiveSection(
  container: RefObject<HTMLElement | null>,
  ids: readonly string[],
): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0])
  const key = ids.join(' ')

  useEffect(() => {
    const pane = container.current
    if (!pane) return
    let frame = 0
    const measure = () => {
      frame = 0
      const line = pane.getBoundingClientRect().top + READING_LINE_PX
      let current: string | undefined = ids[0]
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) current = id
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      pane.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
    // `key` stands for `ids`: a fresh array with the same ids must not re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, key])

  return active
}
