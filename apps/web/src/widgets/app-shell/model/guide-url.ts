/**
 * Which language the User Guide (US-119) opens in, from the reader's browser preference.
 *
 * Only the FIRST preference decides: a reader who lists `fr, vi` asked for French first, and the
 * guide has no French, so they get the English edition rather than a language they ranked second.
 * Anything that is not Vietnamese falls back to English for the same reason.
 *
 * The explicit `index.html` is deliberate: Cloudflare Pages redirects it to the bare folder, and the
 * Vite dev server (which has no directory-index fallback for `public/`) serves it as written.
 */
export const GUIDE_URL_VI = '/guide/index.html'
export const GUIDE_URL_EN = '/guide/en/index.html'

export function guideUrlFor(languages: readonly string[]): string {
  const first = languages[0]?.trim().toLowerCase() ?? ''
  return first === 'vi' || first.startsWith('vi-') ? GUIDE_URL_VI : GUIDE_URL_EN
}
