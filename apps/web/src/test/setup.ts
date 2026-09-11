import '@testing-library/jest-dom'

/**
 * jsdom ships no ResizeObserver, and Radix measures with it — `Popover.Arrow` goes through
 * `@radix-ui/react-use-size`, so any test rendering an arrow throws on mount. A no-op is enough:
 * nothing here asserts on measured geometry, and the alternative was leaving the one popover that
 * points at its trigger untestable.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
