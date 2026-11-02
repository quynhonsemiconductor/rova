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
  /**
   * A file that was edited after it ran, with the pair of hashes known in advance (see
   * {@link EDITED_AFTER_APPLY}). Reported once, at info, instead of joining `mismatched` forever.
   */
  knownEdits: string[];
}

/**
 * Migrations whose file was rewritten AFTER they had already run somewhere, with both hashes named here.
 *
 * This is the exception list the mismatch report stays meaningful by having. `mismatched` is a real signal —
 * "this slot may belong to another file and this one never ran" — and a permanent known-benign entry in it
 * teaches every reader to dismiss the whole warning. So the exception is explicit, narrow, and carries both
 * sides of the pair: the hash the database recorded (what the old text hashed to) and the hash of the file
 * now on disk. Any OTHER recorded hash still reports.
 *
 * 0068 (2026-10-30, #832): ran `CREATE ROLE rally_app` unconditionally, which aborts the first migration on a
 * fresh CNPG database where the migrator owns the database and holds no CREATEROLE. It was rewritten to grant
 * only (creating roles only when the connecting role may), so every database that ran the old text now records
 * a hash the file no longer has. Drizzle never re-runs it — it compares `created_at` alone — and 0137 re-states
 * the grant set for both paths, so nothing diverges. Measured against the old file (`git show 176bb66:…`).
 */
export const EDITED_AFTER_APPLY: ReadonlyMap<
  string,
  { readonly recordedHash: string; readonly fileHash: string }
> = new Map([
  [
    '0068_app_role_least_privilege',
    {
      recordedHash: '6667689c82a32d79f15059920ab2d5ec27cbcdb2b0f5ae5393399291f6451d02',
      fileHash: '40d4ab29101cca8657604edea6be39ee8894f3bbfdc8c46d0dcec197fecfc2c8',
    },
  ],
]);

/**
 * The failure the migrator raises when journal entries are stranded. Only `missing` fails: an entry found
 * neither at its `when` nor by its file's hash ran nowhere, so the schema the code expects is not there
 * and the run must not report success. `mismatched` stays a warning (an edited file is ambiguous), and the
 * allow-listed `knownEdits` never reach here.
 */
export function assertNoMissingMigrations(report: Pick<StrandedReport, 'missing'>): void {
  if (report.missing.length === 0) return;
  throw new Error(
    `${report.missing.length} migration(s) in the journal never ran: ${report.missing.join(', ')}. ` +
      'Drizzle applies only entries past the newest recorded `when`, so a non-ascending or duplicated ' +
      'timestamp strands a file while the run still looks successful. Check that the objects each one ' +
      'creates exist, then apply the file by hand (or recreate a developer database) before deploying.',
  );
}

export function strandedMigrations(
  entries: readonly JournalEntry[],
  recorded: readonly RecordedMigration[],
  /** The sha256 of the entry's file, or undefined when the file does not exist. */
  hashOf: (tag: string) => string | undefined,
  /** Defaults to {@link EDITED_AFTER_APPLY}; a parameter so the rule can be tested without the real pair. */
  editedAfterApply: ReadonlyMap<
    string,
    { readonly recordedHash: string; readonly fileHash: string }
  > = EDITED_AFTER_APPLY,
): StrandedReport {
  const hashByWhen = new Map(recorded.map((r) => [String(r.created_at), r.hash]));
  const recordedHashes = new Set(recorded.map((r) => r.hash));

  const report: StrandedReport = {
    missing: [],
    mismatched: [],
    recordedUnderOtherTimestamp: [],
    knownEdits: [],
  };
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

    // A documented rewrite: the database recorded the pre-edit text, the file hashes to the post-edit text.
    const known = editedAfterApply.get(entry.tag);
    if (known && atWhen === known.recordedHash && hash === known.fileHash) {
      report.knownEdits.push(label);
      continue;
    }

    if (atWhen === undefined) report.missing.push(label);
    else report.mismatched.push(label);
  }
  return report;
}
