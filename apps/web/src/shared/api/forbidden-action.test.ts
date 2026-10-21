/**
 * `forbiddenAction` — a 403 is a REQUEST fact, not an app-level event.
 *
 * The middleware used to answer every 403 with `window.location.href = '/403'`, including the
 * background ones. Under the per-project access model that is not an edge case: an Editor holds most
 * delivery codes and lacks the administrative ones, so the surfaces they legitimately own routinely
 * fan out one request they may not make — an owner roster, a release list, a milestone lookup. Each
 * of those evicted the reader from a page they owned, mid-edit, with a full page load. It also beat
 * every absent-versus-error state in the app, because the navigation won the race against the render.
 *
 * These cases pin the split that replaced it, and the absence of navigation is the point of all of
 * them: a refused READ is the surface's business, a refused WRITE must be said out loud.
 */
import { describe, expect, it } from 'vitest'

import { forbiddenAction } from './http-client'

describe('forbiddenAction', () => {
  it('says nothing for a refused READ — the surface renders its own denial', () => {
    // The regression in one line: this is the background picker feed that used to eject the reader.
    expect(forbiddenAction(403, 'GET', '/v1/projects/p-1/members-with-profile')).toBe('silent')
    expect(forbiddenAction(403, 'HEAD', '/v1/iterations')).toBe('silent')
  })

  it('toasts a refused WRITE, because nothing on screen changed', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(forbiddenAction(403, method, '/v1/work-items/wi-1')).toBe('toast')
    }
  })

  it('is case-insensitive about the method', () => {
    // openapi-fetch hands the method through as given; a lowercase verb must not read as a write.
    expect(forbiddenAction(403, 'get', '/v1/iterations')).toBe('silent')
    expect(forbiddenAction(403, 'patch', '/v1/work-items/wi-1')).toBe('toast')
  })

  it('leaves /auth/* alone — that caller renders its error inline', () => {
    // A WRITE, so it would toast but for the exemption. The workspace switch is one: a 403 there means "you are not a
    // member of that workspace", which the switcher reports itself.
    expect(forbiddenAction(403, 'POST', '/v1/auth/logout-all')).toBe('silent')
    expect(forbiddenAction(403, 'POST', '/v1/auth/switch-workspace')).toBe('silent')
  })

  it("leaves identity 8's own surface (/api/auth/*) alone too", () => {
    // Sign-in and sign-out are not typed-client calls, but a 403 from them (a refused Origin) must never toast over the
    // login form, which renders `?error=<CODE>` itself.
    expect(forbiddenAction(403, 'POST', '/api/auth/sign-in/social')).toBe('silent')
  })

  it('ignores every status that is not 403', () => {
    // 401 is a SESSION fact and still navigates, in the middleware; 404/409/500 belong to the caller.
    for (const status of [200, 401, 404, 409, 500]) {
      expect(forbiddenAction(status, 'POST', '/v1/work-items')).toBe('silent')
    }
  })
})
