import { createContext, useContext } from 'react'
import type { GuideLang } from '../model/guide-url'

export interface GuideContextValue {
  lang: GuideLang
  /** Slug of the chapter on screen; a hash-only `GuideLink` stays on it. */
  chapter: string
  /** The sidebar's search text, which also filters the start page's path cards. */
  query: string
}

export const GuideContext = createContext<GuideContextValue>({
  lang: 'en',
  chapter: '',
  query: '',
})

export function useGuide(): GuideContextValue {
  return useContext(GuideContext)
}

/**
 * Whether the enclosing section is one of the guide's long-form PROSE sections.
 *
 * The static guide had two looks for the same block: inside a `.prose-section` (every chapter
 * section) a callout is a ruled quote and a card grid is a list of rows; outside one (the start
 * page) they are boxed cards. `Section` provides this, so a part that has both looks asks instead of
 * taking a prop the chapter would have to repeat on every callout.
 */
export const ProseContext = createContext(true)

export function useProse(): boolean {
  return useContext(ProseContext)
}
