import { describe, expect, it } from 'vitest'
import { router } from './router'

/**
 * Which route answers a User Guide URL, read from the app's own route tree. Matching only — no
 * `beforeLoad` runs — so this is about the tree's shape: the optional-edition start route must take
 * the bare and edition-only URLs (an old `/guide/` link arrives as `/user-guide/vi/`), and never a
 * chapter URL.
 */
const routeFor = (path: string) => router.matchRoutes(path, {}).at(-1)?.routeId

describe('User Guide routes', () => {
  it.each(['/user-guide', '/user-guide/', '/user-guide/vi', '/user-guide/en/'])(
    '%s opens the start chapter route',
    (path) => {
      expect(routeFor(path)).toBe('/auth/user-guide/{-$lang}')
    },
  )

  it.each(['/user-guide/vi/01-lam-quen', '/user-guide/en/00-bat-dau'])(
    '%s is a chapter',
    (path) => {
      expect(routeFor(path)).toBe('/auth/user-guide/$lang/$chapter')
    },
  )
})
