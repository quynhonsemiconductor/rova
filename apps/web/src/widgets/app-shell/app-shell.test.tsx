/**
 * GAP-P0-SHELL-007 — the Project/Team switcher offers DELIVERY CONTEXT and nothing else.
 *
 * The panel used to end with a divider and a `Manage Projects` link into `/projects`, which made the
 * context switcher a second entrance to project administration. The BA's ruling is that it changes
 * only which project and team the app is pointed at; administration is reached through the Settings
 * gear's `Workspaces & Projects`.
 *
 * A SOURCE-TEXT assertion, like the one `src/test/route-permission.contract.test.tsx` already makes
 * against this same file, and it is worth being honest about why: rendering the shell needs eleven
 * stores, query hooks and router primitives stubbed, and the thing being pinned is an ABSENCE — a
 * render test would assert `queryByText(...) === null`, which passes just as happily when the mocks
 * are wrong and the panel never mounted at all. Text cannot pass vacuously, so for a deletion it is
 * the stronger of the two. The `/projects` ROUTE keeps its own `project:view` gate either way
 * (`NON_NAV_SURFACES` in `shared/config/nav.ts`) — this is about which surfaces offer the doorway.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `import.meta.dirname`, not `__dirname`: apps/web is ESM (the same reason the ratchet tests in
// `src/test` use it and the backend guard specs cannot).
const SHELL = readFileSync(join(import.meta.dirname, 'app-shell.tsx'), 'utf8')

describe('the app shell', () => {
  it('does not route to project administration from the context switcher', () => {
    expect(SHELL).not.toMatch(/to="\/projects"/)
    expect(SHELL).not.toMatch(/Manage Projects\s*</)
  })

  it('still routes to Settings, which is where administration lives', () => {
    // The control. If the gear went with it, the panel's link would have been the only way in and
    // deleting it would have stranded the surface rather than moved it.
    expect(SHELL).toMatch(/to=\{'\/settings'/)
  })

  // US-119: the Help icon opens the User Guide directly — no menu, no placeholder toast.
  it('opens the User Guide from the Help icon instead of a "coming soon" toast', () => {
    expect(SHELL).not.toMatch(/Help & documentation coming soon/)
    expect(SHELL).not.toMatch(/HelpCircle/)
    expect(SHELL).toMatch(/<HelpLink \/>/)
  })
})
