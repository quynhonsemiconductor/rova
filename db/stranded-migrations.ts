/**
 * Which journal entries does the database NOT have, as far as `__drizzle_migrations` can tell?
 *
 * Pure (no database, no filesystem) so it can be tested with fixtures; `db/migrate.ts` feeds it the real rows.
 *
 * A row is matched to an entry two ways, in order:
 *
 *   1. BY TIMESTAMP: a row whose `created_at` equals the entry's `when`. Its hash must be the file's, else the file
 *      was edited after it ran or the slot belongs to another file.
 *   2. BY HASH, when nothing sits at the entry's `when`: a row whose hash is the file's text. drizzle records
 *      `created_at = the entry's `when` AT THE TIME IT RAN`, so an entry whose `when` was later corrected (0006 and
 *      0019 were raised by this change) is found by its file, not by its timestamp. Without this step every database
 *      that ran those two under the old timestamps reports them as stranded, and the advice that comes with the
 *      warning ("recreate the database") is the wrong answer for a database that is fine.
 *
 * Only an entry matched NEITHER way is reported. The hash is the sha256 of the file's raw text, which is what drizzle
 * records.
 */
export interface JournalEntry {
  tag: string;
  when: number;
}

export interface RecordedMigration {
  /** bigint column: the driver may hand it back as a string. */
  created_at: string | number;
  hash: string;
}

export interface StrandedReport {
  /** Nothing in the database corresponds to these entries: they probably never ran. */
  missing: string[];
  /** A row sits at the entry's `when`, but with another file's hash, and this file's hash is recorded nowhere. */
  mismatched: string[];
  /** Matched by hash under a different timestamp: ran, recorded under an older `when`. Informational. */
  recordedUnderOtherTimestamp: string[];
}

export function strandedMigrations(
  entries: readonly JournalEntry[],
  recorded: readonly RecordedMigration[],
  /** The sha256 of the entry's file, or undefined when the file does not exist. */
  hashOf: (tag: string) => string | undefined,
): StrandedReport {
  const hashByWhen = new Map(recorded.map((r) => [String(r.created_at), r.hash]));
  const recordedHashes = new Set(recorded.map((r) => r.hash));

  const report: StrandedReport = { missing: [], mismatched: [], recordedUnderOtherTimestamp: [] };
  for (const entry of entries) {
    const hash = hashOf(entry.tag);
    if (hash === undefined) continue;
    const label = `${entry.tag} (when=${entry.when})`;
    const atWhen = hashByWhen.get(String(entry.when));

    if (atWhen === hash) continue; // the common case: recorded where the journal says

    if (recordedHashes.has(hash)) {
      // It ran. Whether the slot at `when` is empty (a corrected timestamp) or taken by another file, the
      // file itself is recorded, which is the question.
      if (atWhen === undefined) report.recordedUnderOtherTimestamp.push(label);
      continue;
    }
    if (atWhen === undefined) report.missing.push(label);
    else report.mismatched.push(label);
  }
  return report;
}
