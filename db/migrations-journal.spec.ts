/**
 * The migration journal is what drizzle actually applies — not the .sql files on disk.
 *
 * `drizzle-orm`'s migrator reads `meta/_journal.json`, takes the newest `created_at` already recorded in
 * the database ONCE, and applies only the journal entries whose `when` is GREATER, all in one transaction. An
 * entry whose `when` is not above its predecessor's is therefore skipped, silently, on every database that had
 * already applied the predecessor: the file is there, `db:migrate` reports success, and the DDL never runs. A
 * fresh database applies everything in order, so the `test` job's "apply migrations" step cannot tell, and the
 * "Migration upgrade path" job (main's migrations, then this PR's) cannot either — it never checks that the
 * second batch actually ran.
 *
 * It had happened twice in this journal and nothing noticed:
 *
 *   - 0006_enum_columns     (when 1782052333616, 2026-06-21) sat BELOW 0005_rls_tenant_isolation (1782100000000,
 *     a hand-written round number): drizzle-kit stamped 0006 with the real clock while 0005 carried a made-up one.
 *   - 0019_drop_users_tenant_id (1782479593580, 2026-06-26) sat BELOW 0018_users_membership_rls (1782800000000).
 *
 * Both were raised just above their predecessors (still below their successors). That changes nothing for a
 * database that already ran them — drizzle compares each `when` with the newest `created_at` in the database,
 * which is far above these — and it makes a database that was stuck behind either one apply it next time.
 * docs/runbooks/migration-journal-order.md has the read-only SQL to confirm both ran in an environment.
 *
 * Pinned here:
 *   - `idx` runs 0..n-1 with no gap or repeat,
 *   - `when` is STRICTLY increasing,
 *   - every entry names a file that exists and is listed once, and no .sql file lacks an entry (it would never run),
 *   - the tags' numbers never go backwards, and a number is shared only where it already is
 *     ({@link KNOWN_SHARED_NUMBERS}) — two files with one number is how `0028_member_capacity` came to share a
 *     timestamp slot and be skipped once before (#65).
 *
 * Not pinned: that a tag's number equals its idx. It cannot be: 0028 is shared by two files, so every number
 * after it is one below its idx.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Numbers two migration files already share. A NEW shared number fails the guard: pick the next free one. Do not
 * add to this list to make a failure go away.
 */
export const KNOWN_SHARED_NUMBERS: ReadonlySet<string> = new Set(['0028']);

const numberOf = (tag: string): string => tag.slice(0, 4);

/** Every way the journal can be wrong, as readable messages. Empty = sound. */
export function journalProblems(
  entries: Entry[],
  sqlFiles: string[],
  knownShared: ReadonlySet<string> = KNOWN_SHARED_NUMBERS,
): string[] {
  const problems: string[] = [];
  const tags = new Set<string>();
  const numbers = new Map<string, string>();

  entries.forEach((e, i) => {
    if (e.idx !== i) problems.push(`entry ${i} has idx ${e.idx}; idx must run 0..n-1 with no gap`);
    if (!/^\d{4}_/.test(e.tag))
      problems.push(`${e.tag}: a tag starts with a 4-digit number and "_"`);
    if (tags.has(e.tag)) problems.push(`${e.tag}: listed twice`);
    tags.add(e.tag);
    if (!sqlFiles.includes(`${e.tag}.sql`))
      problems.push(`${e.tag}: no such file db/migrations/${e.tag}.sql`);

    const previous = entries[i - 1];
    if (previous && e.when <= previous.when) {
      problems.push(
        `${e.tag}: when ${e.when} is not above ${previous.tag}'s ${previous.when} — drizzle will SKIP it ` +
          `on any database that already applied ${previous.tag}`,
      );
    }
    if (previous && numberOf(e.tag) < numberOf(previous.tag)) {
      problems.push(`${e.tag}: its number goes backwards from ${previous.tag}`);
    }

    const sharer = numbers.get(numberOf(e.tag));
    if (sharer && sharer !== e.tag && !knownShared.has(numberOf(e.tag))) {
      problems.push(
        `${e.tag}: shares number ${numberOf(e.tag)} with ${sharer}; use the next free number`,
      );
    }
    numbers.set(numberOf(e.tag), e.tag);
  });

  for (const file of sqlFiles) {
    if (!tags.has(file.replace(/\.sql$/, ''))) {
      problems.push(`${file}: not in the journal, so it will never run`);
    }
  }
  return problems;
}

/**
 * drizzle's decision, from `pg-core/dialect.js#migrate`: with the newest `created_at` already in the database,
 * an entry is applied iff its `when` is greater. (An empty database applies every entry.)
 */
export function pendingFor(entries: Entry[], newestCreatedAt: number | undefined): Entry[] {
  return entries.filter((e) => newestCreatedAt === undefined || newestCreatedAt < e.when);
}

const dir = join(__dirname, 'migrations');

describe('migration journal', () => {
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Entry[];
  };
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  it('is the journal this guard reads (and not an empty one)', () => {
    expect(journal.entries.length).toBeGreaterThan(100);
    expect(sqlFiles.length).toBe(journal.entries.length);
  });

  it('is sound: contiguous idx, strictly increasing when, every tag a file, no orphan file, no new shared number', () => {
    expect(journalProblems(journal.entries, sqlFiles)).toEqual([]);
  });

  it('applies EXACTLY the later entries to a database at any point in the journal', () => {
    // The property the guard exists for, stated the way drizzle evaluates it: whichever migration a database is
    // up to, the next deploy applies everything after it and nothing else. An out-of-order `when` breaks it.
    journal.entries.forEach((applied, i) => {
      expect(
        pendingFor(journal.entries, applied.when).map((e) => e.tag),
        `a database at ${applied.tag} would not apply exactly what follows`,
      ).toEqual(journal.entries.slice(i + 1).map((e) => e.tag));
    });
  });

  it('keeps the two entries that were once out of order above their predecessors', () => {
    const when = (tag: string) => journal.entries.find((e) => e.tag === tag)!.when;
    expect(when('0006_enum_columns')).toBeGreaterThan(when('0005_rls_tenant_isolation'));
    expect(when('0019_drop_users_tenant_id')).toBeGreaterThan(when('0018_users_membership_rls'));
  });
});

describe('pendingFor — what the bug looked like', () => {
  it('skipped 0006 on a database that had applied 0005, with the old `when`', () => {
    const old: Entry[] = [
      { idx: 5, when: 1782100000000, tag: '0005_rls_tenant_isolation' },
      { idx: 6, when: 1782052333616, tag: '0006_enum_columns' },
      { idx: 7, when: 1782200000000, tag: '0007_email_outbox' },
    ];
    // A database whose newest migration is 0005 applies 0007 but NOT 0006.
    expect(pendingFor(old, 1782100000000).map((e) => e.tag)).toEqual(['0007_email_outbox']);
  });

  it('applies it with the corrected `when`', () => {
    const fixed: Entry[] = [
      { idx: 5, when: 1782100000000, tag: '0005_rls_tenant_isolation' },
      { idx: 6, when: 1782100001000, tag: '0006_enum_columns' },
      { idx: 7, when: 1782200000000, tag: '0007_email_outbox' },
    ];
    expect(pendingFor(fixed, 1782100000000).map((e) => e.tag)).toEqual([
      '0006_enum_columns',
      '0007_email_outbox',
    ]);
  });

  it('does NOT re-run an already-applied migration on a database that is ahead', () => {
    // The corrected `when` is still far below the newest created_at of any deployed database.
    const fixed: Entry[] = [{ idx: 6, when: 1782100001000, tag: '0006_enum_columns' }];
    expect(pendingFor(fixed, 1788342303005)).toEqual([]);
  });
});

describe('journalProblems — each defect is caught', () => {
  const ok: Entry[] = [
    { idx: 0, when: 100, tag: '0000_a' },
    { idx: 1, when: 200, tag: '0001_b' },
    { idx: 2, when: 300, tag: '0002_c' },
  ];
  const files = ['0000_a.sql', '0001_b.sql', '0002_c.sql'];

  it('accepts a sound journal', () => {
    expect(journalProblems(ok, files)).toEqual([]);
  });

  it('catches a `when` that is not above its predecessor (the entry drizzle would skip)', () => {
    const bad = ok.map((e) => (e.idx === 1 ? { ...e, when: 100 } : e));
    expect(journalProblems(bad, files).join('\n')).toMatch(
      /0001_b: when 100 is not above 0000_a.*SKIP/,
    );
    const earlier = ok.map((e) => (e.idx === 2 ? { ...e, when: 50 } : e));
    expect(journalProblems(earlier, files).join('\n')).toMatch(/0002_c: when 50/);
  });

  it('catches a gap or repeat in idx', () => {
    const gap = [ok[0], { idx: 2, when: 200, tag: '0002_c' }];
    expect(journalProblems(gap, files).join('\n')).toMatch(/idx must run 0\.\.n-1/);
  });

  it('catches an entry with no file', () => {
    expect(journalProblems(ok, ['0000_a.sql', '0001_b.sql']).join('\n')).toMatch(
      /0002_c: no such file/,
    );
  });

  it('catches a file with no entry (it would never run)', () => {
    expect(journalProblems(ok, [...files, '0003_d.sql']).join('\n')).toMatch(
      /0003_d.sql: not in the journal/,
    );
  });

  it('catches a tag listed twice', () => {
    const dup = [...ok, { idx: 3, when: 400, tag: '0002_c' }];
    expect(journalProblems(dup, files).join('\n')).toMatch(/0002_c: listed twice/);
  });

  it("catches a tag's number going backwards", () => {
    const back = ok.map((e) => (e.idx === 2 ? { ...e, tag: '0000_z' } : e));
    expect(journalProblems(back, ['0000_a.sql', '0001_b.sql', '0000_z.sql']).join('\n')).toMatch(
      /0000_z: its number goes backwards/,
    );
  });

  it('catches a NEW shared number, and tolerates only the known one', () => {
    const shared = [...ok, { idx: 3, when: 400, tag: '0002_d' }];
    const sharedFiles = [...files, '0002_d.sql'];
    expect(journalProblems(shared, sharedFiles).join('\n')).toMatch(
      /0002_d: shares number 0002 with 0002_c/,
    );
    expect(journalProblems(shared, sharedFiles, new Set(['0002']))).toEqual([]);
  });

  it('catches a tag with no number', () => {
    const bad = ok.map((e) => (e.idx === 1 ? { ...e, tag: 'b' } : e));
    expect(journalProblems(bad, ['0000_a.sql', 'b.sql', '0002_c.sql']).join('\n')).toMatch(
      /a tag starts with a 4-digit number/,
    );
  });
});
