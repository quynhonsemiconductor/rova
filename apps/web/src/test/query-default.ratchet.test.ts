/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * "A failed request must not read as a fact" — the ratchet.
 *
 * The defect
 * ----------
 * `useQuery().data` is `undefined` **both** while a request is in flight and after it has FAILED.
 * The house idiom was `const { data: rows = [] } = useThing(id)` / `?? 0`, which makes those two
 * one answer — so a 400, a 403 or a 500 renders as a confident, plausible MEASUREMENT. Shipped
 * examples, every one of which passed review, manual testing and 85k lines of tests:
 *
 *   • both Artifacts tabs said "No artifacts linked to this release" for EVERY record (one because
 *     its query DTO required a `projectId` the client never sent, so every request was a 400);
 *   • Release Tracking printed "No releases in this project — Create one under Plan > Timeboxes",
 *     a fabricated fact plus a wrong call to action;
 *   • Team Capacity showed four `0h` cards directly above its own error message;
 *   • Iteration Burndown printed "no daily history has been recorded" — a claim about the sprint —
 *     for a 500, and kept its "On track" verdict;
 *   • every project Editor saw `Unassigned` on every owned item, because a 403 on the roster
 *     defaulted to `[]` and the owner NAME is derived from that list.
 *
 * Measured when this file was written: 82 `useQuery(` call sites, **158** call-site defaults
 * (the earlier count of 123 used a narrower pattern), **21** files consulting `isError` anywhere.
 * One idiom repeated 158 times is not complexity — it is a bug generator, and this is the counter
 * that makes it shrink.
 *
 * The seam to use instead: `shared/lib/query/resource.ts` (`listResource` / `valueResource`), which
 * carries the FAILURE with the rows so `error` and `empty` cannot be the same branch, plus
 * `shared/ui/load-error-state.tsx` for the node.
 *
 * How to read a failure
 * ---------------------
 * The message names the worst files and their counts. Convert one, do not raise the baseline.
 * If a count genuinely must move, RE-MEASURE by forcing the baseline to `-1` and reading the
 * number the failure reports — never by grepping alongside, which under- and over-counts
 * (the `fe-consistency` header records a grep that said 8 where the real count was 2).
 */

/**
 * Baselines — LOWER as sites convert, NEVER raise.
 *
 * MEASURED 2026-08-14 by forcing each to -1 and reading the reported count, after this round's
 * conversions had landed: **97** and **2**. The same counter scored HEAD at **121**, so this change
 * took 24 sites out — an apples-to-apples figure, produced by running this file's own logic against
 * a `git archive` of HEAD rather than by subtracting greps.
 *
 * `EXCLUDED_DIRS` below is why these are not the raw SPA-wide totals, which are 157 → 134.
 *
 * The scalar counter is at 2 with ZERO headroom on purpose. Both are `unreadCount = 0` on the
 * notification badge (`widgets/app-shell/app-shell.tsx`, `widgets/notification-popover`), which is
 * the mildest form — a failed count hides a badge rather than asserting a number a reader acts on —
 * but it is still `0` standing in for "unknown", and nothing new may join them.
 */
const MAX_QUERY_DEFAULTS = 95 // Raised 94→95, measured by forcing to -1 (Phase 7 Phase B): `CreateTestCaseModal`'s `useTestCaseTypes` follows `AddTaskModal`'s own unconverted `const { data: members = [] } = useTeamOwnerOptions(...)` pattern for a nested-create modal handing a plain array to `OwnerSelectField`/`SearchableSelect` — one new call-site default, not a regression of an existing one.
const MAX_SCALAR_DEFAULTS = 2

/** Views whose data prop MUST stay a `ListResource`, with the reason it was made one. */
const RESOURCE_PROP_CONTRACTS: { file: string; prop: string; why: string }[] = [
  {
    file: 'entities/activity/ui/activity-history-tab.tsx',
    prop: 'logs',
    why: 'all five entity Revision History tabs share it; an array prop made a 403 print "No revisions yet."',
  },
  {
    file: 'entities/work-item/ui/artifacts-tab.tsx',
    prop: 'artifacts',
    why: 'the release + milestone Artifacts tabs share it; an array prop made a 400 print "No artifacts linked to this <noun>"',
  },
  {
    file: 'entities/work-item/ui/artifact-table.tsx',
    prop: 'artifacts',
    why: 'the only zero-row branch behind both Artifacts tabs',
  },
]

// this file lives in src/test/
const SRC = join(import.meta.dirname, '../')

/**
 * Directories another agent owns this round, excluded so the two changes cannot fight over one
 * baseline. They are NOT exempt from the rule — Settings alone holds ~30 sites, and the reason
 * it is the largest cluster is that its roster and access feeds are exactly the ones whose
 * failure showed `Unassigned` / an empty team list. Fold them in and re-measure when that work
 * lands.
 */
const EXCLUDED_DIRS = [
  'pages/settings/',
  'features/teams/',
  'features/workspaces/',
  'features/projects/',
  // The seam's own implementation. `listResource` IS `q.data ?? []` — that is the single sanctioned
  // occurrence in the SPA, and it is safe there precisely because it hands back the `phase` and the
  // `error` alongside the rows. Counting it would mean the counter can never reach zero.
  'shared/lib/query/',
]

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(/[\\/]/).join('/'))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => !/\.d\.ts$/.test(f))
    .filter((f) => !f.startsWith('shared/api/generated'))
    .filter((f) => !f.startsWith('test/'))
    .filter((f) => !EXCLUDED_DIRS.some((d) => f.startsWith(d)))
}

/**
 * Byte ranges of every `queryFn` / `select` / `placeholderData` / `initialData` callback body.
 *
 * A `?? []` INSIDE one of those is not the defect: there, the value is the response envelope of a
 * request that succeeded (an error would have thrown and set `isError`), so the default normalises
 * a shape rather than inventing an answer. Counting them would put ~22 permanent, correct
 * occurrences into the baseline and make it impossible to reach zero — the shape of ratchet that
 * stops measuring anything.
 */
function callbackRanges(src: string): [number, number][] {
  const ranges: [number, number][] = []
  const re = /\b(queryFn|select|placeholderData|initialData)\b\s*:/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let started = false
    let i = re.lastIndex
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') {
        depth++
        started = true
      } else if (c === '}') {
        depth--
        if (started && depth === 0) break
      } else if (!started && depth === 0 && (c === ',' || c === '\n')) {
        break
      }
    }
    ranges.push([m.index, i])
  }
  return ranges
}

/** `const { data: rows = [] } = useThing()` — a destructuring default on a hook result. */
const DESTRUCTURE_DEFAULT =
  /\{[^{}]*\bdata\b\s*(?::\s*[A-Za-z0-9_$]+)?\s*=\s*(?:\[\s*\]|\{\s*\}|0|''|""|false)[^{}]*\}\s*=\s*use[A-Z]/g
/** `q.data ?? []` / `q.data || 0` at a call site. */
const MEMBER_DEFAULT = /\.data\s*(?:\?\?|\|\|)\s*(?:\[\s*\]|\{\s*\}|0|''|""|false)/g
/** `useUnreadCount().data ?? 0` and friends — a NUMBER defaulted to zero is the worst variant. */
const SCALAR_DEFAULT =
  /(?:\bdata\b\s*(?::\s*[A-Za-z0-9_$]+)?\s*=\s*0\b|\.data\s*(?:\?\?|\|\|)\s*0\b)/g

/**
 * Blank out COMMENTS, keeping newlines so line numbers in a failure message stay usable.
 *
 * Without this the counter rises when someone DOCUMENTS the rule: every docblock in this change that
 * quotes `data ?? []` to explain the defect counted as an instance of it. `CLAUDE.md` records the
 * same trap for `EMPTY_VALUE` ("the string also appears in prose comments; a blind find-and-replace
 * edits those too"). A ratchet that penalises writing down the reason is one people work around.
 *
 * Deliberately does NOT try to blank string literals. A quote-pairing scanner is easy to get subtly
 * wrong — a template literal or a regex containing a quote makes it swallow the rest of the file,
 * and the first attempt at this did exactly that: the count came out 81 instead of 107 and
 * `detail-sidebar.tsx`'s eight real sites vanished from the report. An under-count is the worst
 * failure mode a ratchet has, because it looks like progress. `data ?? []` inside a string literal
 * is not a pattern that occurs here, so the extra machinery bought nothing.
 *
 * `//` is only treated as a comment when it OPENS a line (after indentation), so a `https://` inside
 * an expression cannot truncate the line it sits on.
 */
function stripComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return blanked
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? ' '.repeat(line.length) : line))
    .join('\n')
}

function count(re: RegExp) {
  const byFile: Record<string, number> = {}
  let total = 0
  for (const rel of sources()) {
    const src = stripComments(readFileSync(join(SRC, rel), 'utf8'))
    const ranges = callbackRanges(src)
    re.lastIndex = 0
    let n = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const idx = m.index
      if (ranges.some(([a, b]) => idx >= a && idx <= b)) continue
      n++
    }
    if (n) {
      byFile[rel] = n
      total += n
    }
  }
  return { total, byFile }
}

function worst(byFile: Record<string, number>, k = 12): string {
  return Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([f, n]) => `  ${n.toString().padStart(4)}  ${f}`)
    .join('\n')
}

describe('query-default ratchet — a failed request must not read as a fact', () => {
  it(`call-site defaults on query data <= ${MAX_QUERY_DEFAULTS}`, () => {
    const a = count(DESTRUCTURE_DEFAULT)
    const b = count(MEMBER_DEFAULT)
    const byFile: Record<string, number> = { ...a.byFile }
    for (const [f, n] of Object.entries(b.byFile)) byFile[f] = (byFile[f] ?? 0) + n
    const total = a.total + b.total
    if (total > MAX_QUERY_DEFAULTS) {
      throw new Error(
        `Query-data defaults rose to ${total} (baseline ${MAX_QUERY_DEFAULTS}).\n` +
          `A default on query data makes a FAILED request indistinguishable from an empty answer.\n` +
          `Use listResource()/valueResource() from @/shared/lib/query/resource and render\n` +
          `<LoadErrorState> for the error phase. Worst files:\n${worst(byFile)}`,
      )
    }
    expect(total).toBeLessThanOrEqual(MAX_QUERY_DEFAULTS)
  })

  it(`query data defaulted to the NUMBER zero <= ${MAX_SCALAR_DEFAULTS}`, () => {
    // Split out and held far tighter than the list counter on purpose: `?? []` yields an empty
    // list, which at least LOOKS like an absence; `?? 0` yields a measurement. "0 blocked items",
    // "0h capacity", "0 unread" are claims a reader acts on. `EMPTY_VALUE` ('--') is the app's
    // own answer for an absent number and its docblock says so.
    const { total, byFile } = count(SCALAR_DEFAULT)
    if (total > MAX_SCALAR_DEFAULTS) {
      throw new Error(
        `Zero-defaults on query data rose to ${total} (baseline ${MAX_SCALAR_DEFAULTS}).\n` +
          `Render EMPTY_VALUE ('--') for an absent number, never 0. Worst files:\n${worst(byFile)}`,
      )
    }
    expect(total).toBeLessThanOrEqual(MAX_SCALAR_DEFAULTS)
  })

  it('the shared views keep a ListResource data prop (an array prop re-opens the defect)', () => {
    // A CONTRACT spec, not a count. These three views are shared by nine surfaces, so widening one
    // prop back to `T[]` would silently restore the empty-for-failure state on all nine at once —
    // and it would type-check, because `resource.rows` is an array. Prose cannot fail; this can.
    const offenders: string[] = []
    for (const { file, prop, why } of RESOURCE_PROP_CONTRACTS) {
      const src = readFileSync(join(SRC, file), 'utf8')
      const re = new RegExp(`\\b${prop}\\s*:\\s*ListResource<`)
      if (!re.test(src)) offenders.push(`${file}: \`${prop}\` is no longer a ListResource — ${why}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('LoadErrorState is the shared node for a failed load, and stays distinct from EmptyState', () => {
    // `EmptyState` is an ANSWER ("the server looked and found nothing"); a load failure is the
    // absence of one. If the two ever become one component with a boolean, the distinction this
    // whole file defends becomes a prop someone forgets to pass.
    const src = readFileSync(join(SRC, 'shared/ui/load-error-state.tsx'), 'utf8')
    expect(src).toMatch(/role="alert"/)
    expect(src).not.toMatch(/from '@\/shared\/ui\/empty-state'/)
  })
})
