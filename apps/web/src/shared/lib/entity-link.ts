/**
 * The five clipboard renderings of a record, and the canonical URL each one points at.
 *
 * Rally parity: its `Copy link` popover offers exactly these five rows, in this order, and a
 * reader pasting into Slack, a Markdown doc, an HTML mail or a plain field expects the same
 * five shapes here. The list is CLOSED on purpose — a sixth row belongs in this module, never
 * at a call site, or two detail pages start emitting different Markdown for the same record.
 *
 * PURE by design: no DOM, no clipboard, no router. Formatting is where a feature like this
 * rots — one surface emits `[KEY](url)` and another `[KEY: name](url)` — so the whole set is
 * produced in one place and pinned by `entity-link.test.ts`. The popover only renders what
 * this returns and hands `value`/`html` to the clipboard.
 *
 * ESCAPING IS THE REASON THIS IS TESTED. A title is user input and lands in three different
 * grammars: `]` closes a Markdown label early, `)` closes the target, and `<`/`&` are markup
 * in the HTML row. A record called `Fix (broken) [link] & <tag>` produced a link that pasted
 * as text in every one of them before these escapes existed.
 */

export interface EntityLinkSubject {
  /** The human key a reader recognises — `US-2`, `TC-14`, `RL-3`. */
  key: string
  /** The record's title. User input: assume it contains anything. */
  name: string
  /** Absolute canonical URL, from {@link entityDetailUrl}. */
  url: string
}

export type EntityLinkFormatId =
  | 'linkAndName'
  | 'markdownWithName'
  | 'markdown'
  | 'html'
  | 'plain'

export interface EntityLinkFormat {
  id: EntityLinkFormatId
  /** What lands on the clipboard as `text/plain`, and what the row's input shows. */
  value: string
  /**
   * Present only where the row is meant to paste as a LIVE hyperlink rather than as its own
   * source text — `linkAndName`. The popover writes it as the `text/html` clipboard flavour
   * alongside `value`; everything else is deliberately source text, because a reader copying
   * the Markdown row wants the Markdown, not a rendered link.
   */
  html?: string
}

/** `]` and `\` inside a Markdown link LABEL, and `(`/`)` inside its TARGET. */
function escapeMarkdownLabel(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1')
}

function escapeMarkdownTarget(url: string): string {
  // Angle-bracket form is the spec's own answer to parentheses in a target, and it needs no
  // percent-encoding — which would otherwise change a URL a reader is meant to recognise.
  return /[()\s]/.test(url) ? `<${url}>` : url
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Every rendering of one record, in Rally's order.
 *
 * `key: name` is the app-wide way a record is written in prose (the same shape the bulk-delete
 * copy lists use), so the two name-bearing rows read identically to a reader who has seen one
 * of those.
 */
export function entityLinkFormats(subject: EntityLinkSubject): EntityLinkFormat[] {
  const { key, name, url } = subject
  const label = name ? `${key}: ${name}` : key
  const target = escapeMarkdownTarget(url)

  return [
    // Pastes as a live hyperlink whose visible text is `key: name`; falls back to that text.
    { id: 'linkAndName', value: label, html: `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` },
    { id: 'markdownWithName', value: `[${escapeMarkdownLabel(label)}](${target})` },
    { id: 'markdown', value: `[${escapeMarkdownLabel(key)}](${target})` },
    { id: 'html', value: `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` },
    { id: 'plain', value: url },
  ]
}

// ── Canonical URLs ───────────────────────────────────────────────────────────
//
// One helper per detail route, each mirroring a `path` in `app/router/router.tsx`. They live
// together so the set is auditable against the router in one glance, and they take the same
// param the route declares — so a rename shows up here as a type error rather than as a link
// that 404s only when someone pastes it.
//
// NOT derived from `window.location`: `DetailHeader` also renders as the Backlog's SUMMARY
// PANEL, where the current URL is the list, not the record. A copied link has to address the
// record from wherever the header happens to be mounted.

/** Absolute origin. Split out so a spec can drive it without touching `window`. */
function absolute(path: string, origin: string): string {
  return `${origin.replace(/\/$/, '')}${path}`
}

export const entityDetailPath = {
  workItem: (itemKey: string) => `/item/${encodeURIComponent(itemKey)}`,
  testCase: (testCaseKey: string) => `/test-case/${encodeURIComponent(testCaseKey)}`,
  testResult: (testResultId: string) => `/test-result/${encodeURIComponent(testResultId)}`,
  release: (releaseId: string) => `/releases/${encodeURIComponent(releaseId)}`,
  milestone: (milestoneId: string) => `/milestones/${encodeURIComponent(milestoneId)}`,
  portfolioItem: (itemId: string) => `/portfolio/${encodeURIComponent(itemId)}`,
  project: (projectKey: string) => `/projects/${encodeURIComponent(projectKey)}`,
  iteration: (iterationId: string) => `/timeboxes/${encodeURIComponent(iterationId)}`,
  capacityPlan: (planId: string) => `/capacity-planning/${encodeURIComponent(planId)}`,
} as const

export type EntityKind = keyof typeof entityDetailPath

/**
 * The absolute link a `Copy link` row hands out.
 *
 * `origin` defaults to the running browser's, and is injectable so the formats can be pinned
 * without a DOM.
 */
export function entityDetailUrl(
  kind: EntityKind,
  param: string,
  origin: string = typeof window === 'undefined' ? '' : window.location.origin,
): string {
  return absolute(entityDetailPath[kind](param), origin)
}

/**
 * Subject for a record whose key may be absent — an unsaved draft plan, a new iteration.
 *
 * Returns `undefined` so the result can be handed straight to `DetailHeader`'s `copyLink`: a
 * record with no key has no address a reader could paste, and the control should not render.
 * Centralised because otherwise every nullable-key surface re-decides it, and the two that
 * have one are the two most likely to disagree.
 */
export function entityLinkFor(
  kind: EntityKind,
  param: string | null | undefined,
  key: string | null | undefined,
  name: string | null | undefined,
): EntityLinkSubject | undefined {
  if (!key || !param) return undefined
  return { key, name: name ?? '', url: entityDetailUrl(kind, param) }
}
