/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Query-ordering ratchet — every ORDER BY must be a TOTAL order.
 *
 * `ORDER BY x` where `x` is not unique leaves tied rows in an order SQL does not
 * define. Postgres then returns whatever the scan yields, and an UPDATE that
 * relocates a tuple to another page silently changes it. That is not theoretical
 * here: it is why a work item jumped below its neighbour on the Iteration Status
 * grid after nothing but a schedule-state edit — `getDeterministicRank` in the
 * seed keys off the digits of an item key, so US-1 and DE-1 both got rank
 * 'a0001', and the pair reordered on the next write.
 *
 * Under keyset pagination the same flaw loses data outright: the cursor compares
 * one column, so every row sharing the last row's value is skipped at the page
 * boundary. `activity_logs` alone holds ~6.3k rows across ~5.8k distinct
 * timestamps, because a batch insert stamps one `now()` across the batch.
 *
 * The rule enforced here: the final argument of every `.orderBy(...)` is a
 * unique column — a surrogate `id`, or the columns of a composite primary key
 * for the junction tables that have no `id` (see `work.attachments`).
 * Redundant on a sort that is already unique, and free: Postgres never compares
 * the tiebreaker unless every preceding key is equal.
 *
 * Baseline is ZERO and must stay there. The correct fix is always to append the
 * tiebreaker, never to add an exemption. For a paginated query, use
 * `keysetCondition(sortCol, idCol, cursor)` so the WHERE compares the same pair
 * the ORDER BY sorts on — and pass the matching direction to `buildPageResult`,
 * whose default is 'asc' and which `keysetCondition` reads to choose gt vs lt.
 *
 * __dirname, not import.meta.dirname: CommonJS (see coverage-include.spec.ts).
 */

// ── Baseline — MUST stay 0 ───────────────────────────────────────────────────
const MAX_PARTIAL_ORDERINGS = 0;

/** Sanity floor: if the scanner stops finding queries, fail loudly, not silently. */
const MIN_ORDER_BYS_FOUND = 50;

const ROOT = join(__dirname, '..');

/**
 * Junction tables with no surrogate `id`. Their composite primary key is the
 * unique tuple, so ending on those columns is a total order.
 */
// 'userId' — workspace_members' unique key is the composite (workspace_id, user_id), so a query
// already pinned by workspace_id may end its ORDER BY on user_id (the MCP adapter's workspace
// resolution is the one such query).
const COMPOSITE_KEY_TIEBREAKERS = ['fileId', 'userId'];

interface Ordering {
  file: string;
  line: number;
  text: string;
}

function scanOrderBys(): { all: Ordering[]; partial: Ordering[] } {
  const files = execFileSync('git', ['ls-files', 'libs/**/*.ts', 'apps/**/*.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.includes('.spec.') && !f.includes('.test.'));

  const all: Ordering[] = [];
  const partial: Ordering[] = [];

  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    if (!source.includes('.orderBy(')) continue;
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('.orderBy(')) continue;

      // Collect the whole call, which may span lines, by balancing parens from
      // the first '(' after `.orderBy`.
      let depth = 0;
      let started = false;
      let text = '';
      let done = false;
      for (let j = i; j < Math.min(i + 20, lines.length) && !done; j++) {
        const from = j === i ? lines[j].indexOf('.orderBy(') : 0;
        for (const ch of lines[j].slice(from)) {
          if (ch === '(') {
            depth++;
            started = true;
          } else if (ch === ')') depth--;
          text += ch;
          if (started && depth === 0) {
            done = true;
            break;
          }
        }
        if (!done) text += ' ';
      }

      const ordering = { file, line: i + 1, text: text.replace(/\s+/g, ' ').trim() };
      all.push(ordering);

      // A dynamically-built list (`.orderBy(...arr)`) is only acceptable if the
      // array it spreads is itself terminated by a unique column; the builder is
      // required to append one, so require the marker be visible in this file.
      const spread = /\.orderBy\(\s*\.\.\.(\w+)/.exec(ordering.text);
      if (spread) {
        const builder = source.slice(0, source.indexOf(`.orderBy(...${spread[1]}`));
        if (/asc\([\w.]+\.id\)/.test(builder)) continue;
        partial.push(ordering);
        continue;
      }

      // Otherwise: the LAST argument must be the unique column.
      const args = ordering.text.slice(ordering.text.indexOf('(') + 1, -1);
      const lastArg = splitTopLevel(args).at(-1) ?? '';
      const endsUnique =
        /\.id\b/.test(lastArg) || COMPOSITE_KEY_TIEBREAKERS.some((c) => lastArg.includes(`.${c}`));
      if (!endsUnique) partial.push(ordering);
    }
  }

  return { all, partial };
}

/** Split call arguments on top-level commas only (nested calls contain commas). */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

describe('query-ordering ratchet (must stay at zero)', () => {
  it('finds the query surface it claims to guard', () => {
    const { all } = scanOrderBys();
    expect(
      all.length,
      'Found almost no ORDER BY clauses. The scanner is broken, not the repositories.',
    ).toBeGreaterThanOrEqual(MIN_ORDER_BYS_FOUND);
  });

  it('every ORDER BY ends in a unique column', () => {
    const { partial } = scanOrderBys();

    if (partial.length > MAX_PARTIAL_ORDERINGS) {
      const report = partial.map((o) => `  ${o.file}:${o.line}\n      ${o.text}`).join('\n');
      throw new Error(
        `${partial.length} ORDER BY clause(s) do not end in a unique column.\n` +
          `Tied rows then come back in physical-tuple order, which changes on the ` +
          `next UPDATE — and under keyset pagination the tied rows are skipped ` +
          `entirely. Append the table's id (or its composite key).\n\n${report}`,
      );
    }

    expect(partial.length).toBe(0);
  });
});
