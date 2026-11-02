import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoMissingMigrations,
  EDITED_AFTER_APPLY,
  strandedMigrations,
  type RecordedMigration,
} from './stranded-migrations';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const files: Record<string, string> = {
  '0005_a': 'create a',
  '0006_b': 'create b',
  '0007_c': 'create c',
};
const hashOf = (tag: string) => (tag in files ? sha(files[tag]) : undefined);
const row = (tag: string, created_at: number | string): RecordedMigration => ({
  created_at,
  hash: sha(files[tag]),
});

describe('strandedMigrations', () => {
  const entries = [
    { tag: '0005_a', when: 100 },
    { tag: '0006_b', when: 201 }, // CORRECTED from 150: raised just above its predecessor's
    { tag: '0007_c', when: 300 },
  ];

  it('reports nothing for a database whose rows are where the journal says', () => {
    const rows = [row('0005_a', 100), row('0006_b', 201), row('0007_c', 300)];
    expect(strandedMigrations(entries, rows, hashOf)).toEqual({
      missing: [],
      mismatched: [],
      recordedUnderOtherTimestamp: [],
      knownEdits: [],
    });
  });

  it('EXISTING DATABASE: an entry whose `when` was corrected is found by its hash, not reported as stranded', () => {
    // The database ran 0006 when its `when` was 150; the journal now says 201. Matching by timestamp alone called
    // this "NO recorded row ... recreate the database" on every migrate of every existing database.
    const rows = [row('0005_a', 100), row('0006_b', 150), row('0007_c', 300)];
    const report = strandedMigrations(entries, rows, hashOf);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.recordedUnderOtherTimestamp).toEqual(['0006_b (when=201)']);
  });

  it('still reports an entry that ran nowhere (a stranded file)', () => {
    const rows = [row('0005_a', 100), row('0007_c', 300)];
    expect(strandedMigrations(entries, rows, hashOf).missing).toEqual(['0006_b (when=201)']);
  });

  it('still reports a slot taken by ANOTHER file when this file ran nowhere', () => {
    const rows = [row('0005_a', 100), { created_at: 201, hash: sha('a discarded branch file') }];
    const report = strandedMigrations(entries, rows, hashOf);
    expect(report.mismatched).toEqual(['0006_b (when=201)']);
    expect(report.missing).toEqual(['0007_c (when=300)']);
  });

  it('does not report a file whose hash is recorded even when another file occupies its slot', () => {
    const rows = [
      row('0005_a', 100),
      row('0006_b', 150),
      { created_at: 201, hash: sha('a discarded branch file') },
      row('0007_c', 300),
    ];
    const report = strandedMigrations(entries, rows, hashOf);
    expect(report.mismatched).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it('reports a file edited after it ran (its hash is recorded nowhere)', () => {
    const rows = [
      row('0005_a', 100),
      { created_at: 201, hash: sha('create b, old text') },
      row('0007_c', 300),
    ];
    expect(strandedMigrations(entries, rows, hashOf).mismatched).toEqual(['0006_b (when=201)']);
  });

  it('accepts created_at as the string the driver returns for a bigint', () => {
    const rows = [row('0005_a', '100'), row('0006_b', '201'), row('0007_c', '300')];
    expect(strandedMigrations(entries, rows, hashOf).missing).toEqual([]);
  });

  it('skips an entry whose file does not exist', () => {
    const report = strandedMigrations([{ tag: '0099_gone', when: 999 }], [], hashOf);
    expect(report).toEqual({
      missing: [],
      mismatched: [],
      recordedUnderOtherTimestamp: [],
      knownEdits: [],
    });
  });
});

describe('strandedMigrations — the real journal, on a database that ran 0006 and 0019 under their OLD timestamps', () => {
  const dir = join(__dirname, 'migrations');
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const realHash = (tag: string) => sha(readFileSync(join(dir, `${tag}.sql`), 'utf8'));
  const OLD_WHEN: Record<string, number> = {
    '0006_enum_columns': 1782052333616,
    '0019_drop_users_tenant_id': 1782479593580,
  };

  // What an existing environment has: every entry recorded at the `when` it had when it ran.
  const existing: RecordedMigration[] = journal.entries.map((e) => ({
    created_at: OLD_WHEN[e.tag] ?? e.when,
    hash: realHash(e.tag),
  }));

  it('reports neither as stranded, and says where it found them', () => {
    const report = strandedMigrations(journal.entries, existing, realHash);
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.recordedUnderOtherTimestamp.sort()).toEqual([
      expect.stringContaining('0006_enum_columns'),
      expect.stringContaining('0019_drop_users_tenant_id'),
    ]);
  });

  it('reports neither on a database built after the correction', () => {
    const fresh = journal.entries.map((e) => ({ created_at: e.when, hash: realHash(e.tag) }));
    expect(strandedMigrations(journal.entries, fresh, realHash)).toEqual({
      missing: [],
      mismatched: [],
      recordedUnderOtherTimestamp: [],
      knownEdits: [],
    });
  });

  it('DOES report 0006 on a database that never ran it', () => {
    const without = existing.filter((r) => r.hash !== realHash('0006_enum_columns'));
    expect(strandedMigrations(journal.entries, without, realHash).missing).toEqual([
      expect.stringContaining('0006_enum_columns'),
    ]);
  });

  it('reports 0068 as a KNOWN edit, not as a mismatch, on a database that ran the pre-#832 text', () => {
    // Every database that migrated before 4fbadd6 recorded the OLD 0068 hash; the file on disk hashes to the new
    // one. Without the allow-list this is a permanent entry in `mismatched`, which is how a real mismatch gets
    // dismissed. Both hashes are named in db/stranded-migrations.ts and asserted here against the real pair.
    const pair = EDITED_AFTER_APPLY.get('0068_app_role_least_privilege');
    expect(pair).toBeDefined();
    expect(realHash('0068_app_role_least_privilege')).toBe(pair?.fileHash);

    const rows = journal.entries.map((e) => ({
      created_at: e.when,
      hash: e.tag === '0068_app_role_least_privilege' ? pair!.recordedHash : realHash(e.tag),
    }));
    const report = strandedMigrations(journal.entries, rows, realHash);
    expect(report.mismatched).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.knownEdits).toEqual([expect.stringContaining('0068_app_role_least_privilege')]);
  });

  it('still reports 0068 when the recorded hash is neither the old nor the new one', () => {
    const rows = journal.entries.map((e) => ({
      created_at: e.when,
      hash: e.tag === '0068_app_role_least_privilege' ? sha('some third text') : realHash(e.tag),
    }));
    const report = strandedMigrations(journal.entries, rows, realHash);
    expect(report.knownEdits).toEqual([]);
    expect(report.mismatched).toEqual([expect.stringContaining('0068_app_role_least_privilege')]);
  });
});

describe('assertNoMissingMigrations', () => {
  it('passes when nothing is missing (mismatched and known edits never fail the Job)', () => {
    expect(() => assertNoMissingMigrations({ missing: [] })).not.toThrow();
  });

  it('throws naming every stranded file', () => {
    expect(() => assertNoMissingMigrations({ missing: ['0125_api_tokens', '0126_x'] })).toThrow(
      /2 migration\(s\) in the journal never ran: 0125_api_tokens, 0126_x/,
    );
  });

  it('fails end to end for a stranded entry and passes for a mismatch', () => {
    const entries = [
      { tag: '0005_a', when: 100 },
      { tag: '0006_b', when: 200 },
    ];
    const stranded = strandedMigrations(entries, [row('0005_a', 100)], hashOf);
    expect(() => assertNoMissingMigrations(stranded)).toThrow(/0006_b/);
    const edited = strandedMigrations(
      entries,
      [row('0005_a', 100), { created_at: 200, hash: sha('other text') }],
      hashOf,
    );
    expect(edited.mismatched).toEqual(['0006_b (when=200)']);
    expect(() => assertNoMissingMigrations(edited)).not.toThrow();
  });
});
