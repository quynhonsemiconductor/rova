import type { ActivityChange } from './activity-log.types';

/**
 * Config-driven field diff — the single replacement for every per-module diff
 * (diffWorkItem / diffIteration) and the duplicated `changed()` helpers.
 */
export interface ActivityDiffConfig<T> {
  /** Fields to diff, in the order entries should be emitted. */
  fields: (keyof T & string)[];
  /**
   * Fields whose body is a rich-text document — logged as a bounded plain-text PREVIEW
   * ({@link richTextPreview}), never the markup and never the whole document.
   */
  richText?: (keyof T & string)[];
  /** Field → action name (e.g. `scheduleState` → 'work_item.schedule_state_changed').
   *  When omitted, the caller supplies the action. */
  action?: (field: string) => string;
}

export interface ActivityDiffEntry {
  /** Present when the config maps the field to an action; else the caller decides. */
  action?: string;
  change: ActivityChange;
}

/** Longest plain-text preview a rich-text field change records. Bounded on purpose — see below. */
export const RICH_TEXT_PREVIEW_MAX = 120;

/**
 * The value a rich-text field change records: its text, flattened and bounded.
 *
 * DE-18. Rich-text fields used to log `old: null, new: null` — the field NAME only — and the reader
 * saw the consequence: "Notes changed from (empty) to (empty)" for an edit that saved real text.
 * Enum and number changes rendered their values, so the log was legible for everything EXCEPT the
 * seven fields a tester actually writes into, and US-93/US-97's stated purpose (review the change)
 * could not be served by it.
 *
 * A preview, not the body, and the distinction is the whole design:
 *   • the markup goes — `activity_logs` is a feed, and storing HTML would make every row a partial
 *     copy of a document that has its own home and its own sanitiser;
 *   • the length is capped at {@link RICH_TEXT_PREVIEW_MAX}, so one row's size is bounded no matter
 *     how long the field grows — a 40KB Description cannot land 40KB in an append-only table twice
 *     (once as `old`, once as `new`) per save;
 *   • an empty/blank body stays `null`, so "(empty)" keeps meaning empty rather than "blank markup".
 *
 * Tag boundaries become a space BEFORE tags are stripped, or `<p>a</p><p>b</p>` would read "ab".
 */
export function richTextPreview(value: unknown): string | null {
  // A rich-text column is text or NULL, so anything else is a config mistake (a non-text field
  // declared `richText`). Previewing it would stringify an object into the feed; returning null
  // degrades to "X changed" instead, which is true of any value.
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > RICH_TEXT_PREVIEW_MAX ? `${text.slice(0, RICH_TEXT_PREVIEW_MAX)}…` : text;
}

/** Normalise numeric-string / null|undefined for a stable "did it change" check. */
export function changed(before: unknown, after: unknown): boolean {
  const a = before === undefined ? null : before;
  const b = after === undefined ? null : after;
  if (a === null && b === null) return false;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(a) !== String(b);
}

/**
 * Diff `before` against the requested `input` change-set per `config`. Only
 * fields present in `input` AND actually changed produce an entry; rich-text
 * fields record a bounded plain-text preview of each side ({@link richTextPreview}),
 * never the markup and never the whole document.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  input: Partial<T>,
  config: ActivityDiffConfig<T>,
): ActivityDiffEntry[] {
  const rich = new Set<string>(config.richText ?? []);
  const cur = before as Record<string, unknown>;
  const next = input as Record<string, unknown>;
  const out: ActivityDiffEntry[] = [];

  for (const field of config.fields) {
    if (next[field] === undefined) continue;
    if (!changed(cur[field], next[field])) continue;
    const isRich = rich.has(field);
    out.push({
      action: config.action?.(field),
      change: {
        field,
        old: isRich ? richTextPreview(cur[field]) : (cur[field] ?? null),
        new: isRich ? richTextPreview(next[field]) : (next[field] ?? null),
      },
    });
  }
  return out;
}
