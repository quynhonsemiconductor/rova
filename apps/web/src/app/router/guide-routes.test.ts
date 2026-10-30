import { afterEach, describe, expect, it, vi } from 'vitest'
import { router } from './router'

/**
 * Which route answers a User Guide URL, read from the app's own route tree. Matching only — no
 * `beforeLoad` runs — so this is about the tree's shape: the optional-edition start route must take
 * the bare and edition-only URLs (an old `/guide/` link arrives as `/user-guide/vi/`), and never a
 * chapter URL.
 */
const routeFor = (path: string) => router.matchRoutes(path, {}).at(-1)?.routeId

describe('User Guide routes', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['/user-guide', '/user-guide/', '/user-guide/vi', '/user-guide/en/'])(
    '%s opens the start chapter route',
    (path) => {
      expect(routeFor(path)).toBe('/auth/user-guide/{-$lang}')
    },
  )

  it.each([
    [{}, ['vi-VN'], 'vi'],
    [{}, ['en-US'], 'en'],
    [{ lang: 'vi' }, ['en-US'], 'vi'],
    [{ lang: 'en' }, ['vi'], 'en'],
  ])('sends %j (browser %j) to the %s start chapter', (params, languages, lang) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
    const beforeLoad = router.routesById['/auth/user-guide/{-$lang}'].options.beforeLoad as (ctx: {
      params: { lang?: string }
    }) => void
    let thrown: unknown
    try {
      beforeLoad({ params })
    } catch (error) {
      thrown = error
    }
    expect((thrown as { options?: unknown })?.options).toMatchObject({
      to: '/user-guide/$lang/$chapter',
      params: { lang, chapter: '00-bat-dau' },
      replace: true,
    })
  })

  it.each(['/user-guide/vi/01-lam-quen', '/user-guide/en/00-bat-dau'])(
    '%s is a chapter',
    (path) => {
      expect(routeFor(path)).toBe('/auth/user-guide/$lang/$chapter')
    },
  )
})
