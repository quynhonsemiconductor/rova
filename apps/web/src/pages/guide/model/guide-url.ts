/*
 * The fixed parts of the guide's URL, `/user-guide/<lang>/<chapter>#<section>`. Kept apart from the
 * table of contents so the router can import them without pulling the TOC into the shell bundle.
 */

/** The chapter the guide opens on. */
export const START_CHAPTER = '00-bat-dau'

/**
 * The User Guide's two editions. The guide is bilingual although the app is English-only: the BA
 * wrote a full Vietnamese and a full English edition (US-119), so the language is a property of the
 * guide's URL, not of the app's i18n.
 */
export const GUIDE_LANGS = ['vi', 'en'] as const
export type GuideLang = (typeof GUIDE_LANGS)[number]

export function isGuideLang(value: unknown): value is GuideLang {
  return typeof value === 'string' && (GUIDE_LANGS as readonly string[]).includes(value)
}

/**
 * Which edition the guide opens in, from the reader's browser preference.
 *
 * Only the FIRST preference decides: a reader who lists `fr, vi` asked for French first, and the
 * guide has no French, so they get the English edition rather than a language they ranked second.
 * Anything that is not Vietnamese falls back to English for the same reason.
 */
export function guideLangFor(languages: readonly string[]): GuideLang {
  const first = languages[0]?.trim().toLowerCase() ?? ''
  return first === 'vi' || first.startsWith('vi-') ? 'vi' : 'en'
}

/** `guideLangFor` over the current browser, for callers outside a test. */
export function browserGuideLang(): GuideLang {
  return guideLangFor(navigator.languages ?? [navigator.language])
}
