/**
 * Drizzle schema registry — re-exports all table definitions grouped by Postgres schema.
 * Drizzle-kit and DrizzleProvider both import from this single entry point.
 *
 * Table definitions are generated/maintained per bounded context under their
 * corresponding subdirectory. Add new schema files here as they are created.
 */

// ── shared enums (must be first — tables import from here) ────────────────
export * from './enums';

// ── workspace schema ─────────────────────────────────────────────────────────
export * from './workspace';

// ── identity schema ────────────────────────────────────────────────────────
export * from './identity';

// ── identity v8 tables (Better Auth; additive, unused until the cutover) ───────
export * from './identity-auth';

// ── access schema ──────────────────────────────────────────────────────────
export * from './access';

// ── storage schema (must precede work — work.attachments FKs it) ──
export * from './storage';

// ── work schema ────────────────────────────────────────────────────────────
export * from './work';

// ── messaging schema ──────────────────────────────────────────────────────
export * from './messaging';

// ── scm schema (source-control connections + changesets) ──────────────────
export * from './scm';

// ── notifications schema ──────────────────────────────────────────────────
export * from './notifications';

// ── audit schema ──────────────────────────────────────────────────────────
export * from './audit';
